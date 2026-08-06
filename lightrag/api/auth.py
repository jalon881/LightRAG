from datetime import datetime, timedelta, timezone

import jwt
from dotenv import load_dotenv
from fastapi import HTTPException, status
from pydantic import BaseModel

from ..utils import logger
from .config import DEFAULT_TOKEN_SECRET, global_args
from .passwords import BCRYPT_PASSWORD_PREFIX, verify_password

# use the .env that is inside the current folder
# allows to use different .env file for each lightrag instance
# the OS environment variables take precedence over the .env file
load_dotenv(dotenv_path=".env", override=False)

# A syntactically valid bcrypt spec used only to equalize login timing (see
# AuthHandler.verify_password). It is a bcrypt hash of a throwaway value that
# never matches any real password, and it is not a secret. Every login path
# runs exactly one bcrypt verification (a real one for {bcrypt} accounts, this
# dummy for unknown usernames and for plaintext accounts) so response time does
# not reveal whether an account exists or whether it is stored as plaintext
# (username enumeration via the ~100 ms bcrypt delay, CWE-208).
#
# The cost factor is 12, matching hash_password()/bcrypt.gensalt() defaults.
# Accounts stored with a hand-chosen, different bcrypt cost will still differ
# somewhat; fully closing that gap requires enforcing a uniform cost (or
# dropping plaintext support altogether). See GHSA-c759-cx9p-mrwq.
_DUMMY_VERIFY_SPEC = (
    BCRYPT_PASSWORD_PREFIX
    + "$2b$12$ilI0sY2jGfy4h0AVtn6WuutU6BFwzZq5MVvrQYY9fbyQ59NI2NBKa"
)


class TokenPayload(BaseModel):
    sub: str  # Username
    exp: datetime  # Expiration time
    role: str = "user"  # User role, default is regular user
    token_version: int = 0  # Incremented when a new token is generated for the user
    metadata: dict = {}  # Additional metadata


class AuthHandler:
    def __init__(self):
        auth_accounts = global_args.auth_accounts
        self.secret = global_args.token_secret
        if not self.secret:
            if auth_accounts:
                raise ValueError(
                    "TOKEN_SECRET must be explicitly set to a non-default value when AUTH_ACCOUNTS is configured."
                )
            self.secret = DEFAULT_TOKEN_SECRET
            logger.warning(
                "TOKEN_SECRET not set and AUTH_ACCOUNTS is not configured. "
                "Falling back to the default guest-mode JWT secret. "
            )
        algorithm = global_args.jwt_algorithm
        if not algorithm or algorithm.lower() == "none":
            raise ValueError(
                "JWT_ALGORITHM must be set to a secure algorithm (e.g. HS256). "
                "The 'none' algorithm is not permitted."
            )
        self.algorithm = algorithm
        self.expire_hours = global_args.token_expire_hours
        self.guest_expire_hours = global_args.guest_token_expire_hours
        self.accounts = {}
        invalid_accounts = []
        if auth_accounts:
            for account in auth_accounts.split(","):
                try:
                    username, password = account.split(":", 1)
                    if not username or not password:
                        raise ValueError
                    self.accounts[username] = password
                except ValueError:
                    invalid_accounts.append(account)
        if invalid_accounts:
            invalid_entries = ", ".join(invalid_accounts)
            logger.error(f"Invalid account format in AUTH_ACCOUNTS: {invalid_entries}")
            raise ValueError(
                "AUTH_ACCOUNTS must use comma-separated user:password pairs."
            )

    def verify_password(self, username: str, plain_password: str) -> bool:
        """
        Verify password for a user. Supports explicit bcrypt values and plaintext.

        Args:
            username: Username to verify
            plain_password: Plaintext password to check

        Returns:
            bool: True if password is correct, False otherwise
        """
        # Every branch performs exactly one bcrypt verification so response time
        # cannot be used to enumerate usernames or distinguish plaintext from
        # bcrypt accounts (CWE-208). See _DUMMY_VERIFY_SPEC.
        stored_password = self.accounts.get(username)

        if stored_password is None:
            # Unknown username: run the dummy bcrypt, then fail.
            verify_password(plain_password, _DUMMY_VERIFY_SPEC)
            return False

        if not stored_password.startswith(BCRYPT_PASSWORD_PREFIX):
            # Known plaintext account: the constant-time plaintext compare is
            # only microseconds, so add one dummy bcrypt to match the cost of an
            # unknown username and a {bcrypt} account. Keep the real result.
            password_matches = verify_password(plain_password, stored_password)
            verify_password(plain_password, _DUMMY_VERIFY_SPEC)
            return password_matches

        # Known {bcrypt} account: the real verification already costs one bcrypt.
        return verify_password(plain_password, stored_password)

    # In-memory cache of current token_version per user.
    # Populated on-demand from the user data file; cleared when a new
    # token is generated via the user management API.
    _token_version_cache: dict[str, int] = {}

    def create_token(
        self,
        username: str,
        role: str = "user",
        custom_expire_hours: int = None,
        token_version: int = 0,
        metadata: dict = None,
    ) -> str:
        """
        Create JWT token

        Args:
            username: Username
            role: User role, default is "user", guest is "guest"
            custom_expire_hours: Custom expiration time (hours), if None use default value
            token_version: Token version; older versions are rejected on validation
            metadata: Additional metadata

        Returns:
            str: Encoded JWT token
        """
        # Choose default expiration time based on role
        if custom_expire_hours is None:
            if role == "guest":
                expire_hours = self.guest_expire_hours
            else:
                expire_hours = self.expire_hours
        else:
            expire_hours = custom_expire_hours

        expire = datetime.now(timezone.utc) + timedelta(hours=expire_hours)

        # Create payload
        payload = TokenPayload(
            sub=username, exp=expire, role=role,
            token_version=token_version,
            metadata=metadata or {}
        )

        return jwt.encode(payload.model_dump(), self.secret, algorithm=self.algorithm)

    def validate_token(self, token: str) -> dict:
        """
        Validate JWT token

        Args:
            token: JWT token

        Returns:
            dict: Dictionary containing user information

        Raises:
            HTTPException: If token is invalid or expired
        """
        try:
            # Explicitly exclude 'none' to prevent algorithm confusion attacks
            allowed_algorithms = [self.algorithm]
            if "none" in (a.lower() for a in allowed_algorithms):
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Insecure JWT algorithm configuration",
                )
            payload = jwt.decode(token, self.secret, algorithms=allowed_algorithms)
            expire_timestamp = payload["exp"]
            try:
                expire_time = datetime.fromtimestamp(expire_timestamp, timezone.utc)
            except (OSError, OverflowError, ValueError):
                # Timestamp out of range for the platform (e.g. Windows 32-bit
                # time_t limit).  A value this large means the token is set to
                # essentially never expire; treat it as valid.
                expire_time = datetime.max.replace(tzinfo=timezone.utc)

            if datetime.now(timezone.utc) > expire_time:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired"
                )

            # Check token_version against server-side user record.
            # When an admin generates a new token for a user, the stored
            # token_version is incremented so all old tokens become invalid.
            token_version = payload.get("token_version", 0)
            if token_version > 0:
                stored_version = self._token_version_cache.get(payload["sub"])
                if stored_version is None:
                    # Lazy-load from user data file
                    stored_version = self._load_user_token_version(payload["sub"])
                if stored_version > token_version:
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Token has been superseded by a newer token",
                    )

            # Return complete payload instead of just username
            return {
                "username": payload["sub"],
                "role": payload.get("role", "user"),
                "metadata": payload.get("metadata", {}),
                "exp": expire_time,
                "token_version": token_version,
            }
        except jwt.PyJWTError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
            )

    def _load_user_token_version(self, username: str) -> int:
        """Load the current token_version for a user from the data file."""
        try:
            import json
            from pathlib import Path
            from .config import global_args as _cfg
            path = Path(_cfg.working_dir) / ".user_data.json"
            if path.exists():
                users = json.loads(path.read_text(encoding="utf-8"))
                for u in users:
                    if u.get("username") == username:
                        version = u.get("token_version", 0)
                        self._token_version_cache[username] = version
                        return version
        except Exception:
            pass
        self._token_version_cache[username] = 0
        return 0

    @staticmethod
    def bump_token_version(username: str) -> int:
        """Increment and return the new token_version for a user.
        Called by the user management API after generating a new token.
        Also updates the in-memory cache.
        """
        try:
            import json
            from pathlib import Path
            from .config import global_args as _cfg
            path = Path(_cfg.working_dir) / ".user_data.json"
            if not path.exists():
                return 1
            users = json.loads(path.read_text(encoding="utf-8"))
            new_version = 0
            for u in users:
                if u.get("username") == username:
                    new_version = u.get("token_version", 0) + 1
                    u["token_version"] = new_version
                    break
            if new_version == 0:
                return 1
            path.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
            # Invalidate cache so next validation re-reads
            auth_handler._token_version_cache.pop(username, None)
            return new_version
        except Exception:
            return 1


auth_handler = AuthHandler()

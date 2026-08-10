"""
User management routes for the LightRAG API.

Provides CRUD operations for users, lock/unlock, and menu permission management.
User data is persisted as a JSON file next to the working directory.

Endpoints
---------
* ``GET    /users``              list all users
* ``POST   /users``              create a new user
* ``PUT    /users/{username}``   update user (password, role)
* ``DELETE /users/{username}``   delete a user
* ``PUT    /users/{username}/lock``    toggle lock status
* ``PUT    /users/{username}/permissions``  update menu permissions
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lightrag.api.auth import auth_handler
from lightrag.api.passwords import BCRYPT_PASSWORD_PREFIX, hash_password
from lightrag.utils import logger

from ..config import global_args
from ..utils_api import get_combined_auth_dependency

# ---------------------------------------------------------------------------
# User data model
# ---------------------------------------------------------------------------

# Default menu items available in the sidebar
AVAILABLE_MENU_ITEMS = [
    "dashboard",
    "knowledge-base",
    "documents",
    "knowledge-graph",
    "retrieval",
    "users",
]

class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=64, description="Username")
    password: str = Field(..., min_length=1, max_length=128, description="Password")
    role: str = Field("user", pattern="^(admin|user|trial)$", description="User role")
    permissions: List[str] = Field(
        default_factory=lambda: list(AVAILABLE_MENU_ITEMS),
        description="Allowed menu items",
    )
    documents_quota: Optional[int] = Field(None, ge=0, description="Document upload quota (trial users only)")


class UserUpdate(BaseModel):
    password: Optional[str] = Field(None, max_length=128, description="New password")
    role: Optional[str] = Field(None, pattern="^(admin|user|trial)$", description="User role")
    documents_quota: Optional[int] = Field(None, ge=0, description="Document upload quota (trial users only)")


class UserLockToggle(BaseModel):
    locked: bool = Field(..., description="Lock or unlock the user")


class UserPermissionsUpdate(BaseModel):
    permissions: List[str] = Field(
        ..., description="List of allowed menu item keys"
    )


class UserInfo(BaseModel):
    username: str
    role: str
    locked: bool
    permissions: List[str]
    created_at: str
    token_expires_at: Optional[int] = None
    login_token: Optional[str] = None
    documents_quota: Optional[int] = None
    documents_used: Optional[int] = None


class UserListResponse(BaseModel):
    users: List[UserInfo]
    total: int
    available_menus: List[str]


# ---------------------------------------------------------------------------
# User storage
# ---------------------------------------------------------------------------
_USER_DATA_LOCK = asyncio.Lock()
_USER_DATA_FILENAME = ".user_data.json"


def _user_data_path() -> Path:
    """Return the path to the user data JSON file."""
    return Path(global_args.working_dir) / _USER_DATA_FILENAME


def _default_users() -> List[Dict[str, Any]]:
    """Return the default admin user."""
    return [
        {
            "username": "admin",
            "password": "{bcrypt}$2b$12$iV5p5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
            "role": "admin",
            "locked": False,
            "permissions": list(AVAILABLE_MENU_ITEMS),
            "created_at": "2025-01-01T00:00:00Z",
        }
    ]


def _hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return hash_password(password)


async def _read_users() -> List[Dict[str, Any]]:
    """Read users from the JSON file. Creates the file with defaults if missing."""
    path = _user_data_path()
    async with _USER_DATA_LOCK:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            defaults = _default_users()
            # Hash the default admin password
            defaults[0]["password"] = _hash_password("admin123")
            path.write_text(
                json.dumps(defaults, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return defaults
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                return raw
        except Exception as exc:
            logger.error(f"Failed to read user data: {exc}")
        return list(_default_users())


async def _write_users(users: List[Dict[str, Any]]) -> None:
    """Write users to the JSON file."""
    path = _user_data_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _find_user(users: List[Dict[str, Any]], username: str) -> Optional[Dict[str, Any]]:
    """Find a user by username."""
    for u in users:
        if u["username"] == username:
            return u
    return None


# ---------------------------------------------------------------------------
# Document quota helpers (used by document routes)
# ---------------------------------------------------------------------------

TRIAL_DOCUMENTS_QUOTA = 2


async def check_and_consume_document_quota(username: str) -> None:
    """Atomically check and consume one document upload quota for a trial user.

    Raises HTTPException(429) if the quota is exhausted.
    Admin and regular users are unlimited (no-op).

    The check-and-increment is performed under _USER_DATA_LOCK so concurrent
    uploads from the same trial user cannot race past the quota.
    """
    async with _USER_DATA_LOCK:
        users = await _read_users()
        user = _find_user(users, username)
        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        role = user.get("role", "user")
        if role != "trial":
            return  # No quota for admin / regular users

        quota = user.get("documents_quota", TRIAL_DOCUMENTS_QUOTA)
        used = user.get("documents_used", 0)

        if used >= quota:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"已将上传配额用完 ({used}/{quota})。"
                    f"试用用户最多只能上传 {quota} 个文档，"
                    "请联系管理员升级为正式用户。"
                ),
            )

        # Atomically increment under the lock
        user["documents_used"] = used + 1
        await _write_users(users)


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------


def create_user_routes(
    api_key: str = None,
) -> APIRouter:
    """Create the user management router.

    Args:
        api_key: Optional API key for authentication

    Returns:
        APIRouter: Configured router with user management endpoints
    """
    router = APIRouter(prefix="/users", tags=["User Management"])

    auth_dependency = get_combined_auth_dependency(api_key)

    @router.get("", response_model=UserListResponse)
    async def list_users(_=Depends(auth_dependency)):
        """List all users."""
        users = await _read_users()
        user_list = [
            UserInfo(
                username=u["username"],
                role=u.get("role", "user"),
                locked=u.get("locked", False),
                permissions=u.get("permissions", list(AVAILABLE_MENU_ITEMS)),
                created_at=u.get("created_at", ""),
                token_expires_at=u.get("token_expires_at"),
                login_token=u.get("login_token"),
                documents_quota=u.get("documents_quota"),
                documents_used=u.get("documents_used"),
            )
            for u in users
        ]
        return UserListResponse(
            users=user_list,
            total=len(user_list),
            available_menus=AVAILABLE_MENU_ITEMS,
        )

    @router.post("", response_model=UserInfo)
    async def create_user(data: UserCreate, _=Depends(auth_dependency)):
        """Create a new user."""
        # Validate username
        username = data.username.strip()
        if not username:
            raise HTTPException(status_code=400, detail="Username cannot be empty")

        # Check for invalid characters
        import re

        if not re.match(r"^[a-zA-Z0-9_\-\.@]+$", username):
            raise HTTPException(
                status_code=400,
                detail="Username can only contain letters, numbers, underscores, hyphens, dots, and @",
            )

        users = await _read_users()

        # Check for duplicate
        if _find_user(users, username):
            raise HTTPException(status_code=409, detail=f"User '{username}' already exists")

        # Validate permissions
        for perm in data.permissions:
            if perm not in AVAILABLE_MENU_ITEMS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid menu permission: '{perm}'. Available: {', '.join(AVAILABLE_MENU_ITEMS)}",
                )

        new_user = {
            "username": username,
            "password": _hash_password(data.password),
            "role": data.role,
            "locked": False,
            "permissions": list(data.permissions),
            "created_at": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc
            ).isoformat(),
        }
        # Trial users get a document upload quota (configurable via API)
        if data.role == "trial":
            new_user["documents_quota"] = data.documents_quota if data.documents_quota is not None else 2
            new_user["documents_used"] = 0
        users.append(new_user)
        await _write_users(users)
        logger.info(f"User '{username}' created with role '{data.role}'")

        return UserInfo(
            username=new_user["username"],
            role=new_user["role"],
            locked=new_user["locked"],
            permissions=new_user["permissions"],
            created_at=new_user["created_at"],
            token_expires_at=new_user.get("token_expires_at"),
            documents_quota=new_user.get("documents_quota"),
            documents_used=new_user.get("documents_used"),
        )

    @router.put("/{username}", response_model=UserInfo)
    async def update_user(username: str, data: UserUpdate, _=Depends(auth_dependency)):
        """Update a user's password and/or role."""
        users = await _read_users()
        user = _find_user(users, username)
        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        if data.password:
            user["password"] = _hash_password(data.password)
        if data.role is not None:
            user["role"] = data.role
            # Initialize/reset quota when changing role to trial
            if data.role == "trial":
                if "documents_quota" not in user:
                    user["documents_quota"] = 2
                    user["documents_used"] = 0
            else:
                # Remove quota fields for non-trial roles
                user.pop("documents_quota", None)
                user.pop("documents_used", None)
        if data.documents_quota is not None and user.get("role") == "trial":
            user["documents_quota"] = data.documents_quota
            # Reset used count if quota increased past current usage
            if user.get("documents_used", 0) > data.documents_quota:
                user["documents_used"] = data.documents_quota

        await _write_users(users)
        logger.info(f"User '{username}' updated")

        return UserInfo(
            username=user["username"],
            role=user["role"],
            locked=user.get("locked", False),
            permissions=user.get("permissions", list(AVAILABLE_MENU_ITEMS)),
            created_at=user.get("created_at", ""),
            token_expires_at=user.get("token_expires_at"),
            documents_quota=user.get("documents_quota"),
            documents_used=user.get("documents_used"),
        )

    @router.delete("/{username}")
    async def delete_user(username: str, _=Depends(auth_dependency)):
        """Delete a user. Cannot delete the default 'admin' user."""
        if username == "admin":
            raise HTTPException(status_code=400, detail="Cannot delete the default admin user")

        users = await _read_users()
        user = _find_user(users, username)
        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        users[:] = [u for u in users if u["username"] != username]
        await _write_users(users)
        logger.info(f"User '{username}' deleted")

        return {"status": "deleted", "username": username}

    @router.put("/{username}/lock", response_model=UserInfo)
    async def toggle_lock_user(
        username: str, data: UserLockToggle, _=Depends(auth_dependency)
    ):
        """Lock or unlock a user. Cannot lock the default 'admin' user."""
        if username == "admin" and data.locked:
            raise HTTPException(status_code=400, detail="Cannot lock the default admin user")

        users = await _read_users()
        user = _find_user(users, username)
        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        user["locked"] = data.locked
        await _write_users(users)
        logger.info(f"User '{username}' {'locked' if data.locked else 'unlocked'}")

        return UserInfo(
            username=user["username"],
            role=user["role"],
            locked=user["locked"],
            permissions=user.get("permissions", list(AVAILABLE_MENU_ITEMS)),
            created_at=user.get("created_at", ""),
            token_expires_at=user.get("token_expires_at"),
            documents_quota=user.get("documents_quota"),
            documents_used=user.get("documents_used"),
        )

    @router.put("/{username}/permissions", response_model=UserInfo)
    async def update_user_permissions(
        username: str, data: UserPermissionsUpdate, _=Depends(auth_dependency)
    ):
        """Update a user's menu permissions."""
        # Validate permissions
        for perm in data.permissions:
            if perm not in AVAILABLE_MENU_ITEMS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid menu permission: '{perm}'. Available: {', '.join(AVAILABLE_MENU_ITEMS)}",
                )

        users = await _read_users()
        user = _find_user(users, username)
        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        user["permissions"] = list(data.permissions)
        await _write_users(users)
        logger.info(f"User '{username}' permissions updated: {data.permissions}")

        return UserInfo(
            username=user["username"],
            role=user["role"],
            locked=user.get("locked", False),
            permissions=user["permissions"],
            created_at=user.get("created_at", ""),
            token_expires_at=user.get("token_expires_at"),
            documents_quota=user.get("documents_quota"),
            documents_used=user.get("documents_used"),
        )

    @router.post("/{username}/token")
    async def generate_user_token(
        username: str,
        expire_hours: int | None = None,
        _=Depends(auth_dependency),
    ):
        """Generate a new JWT token for the specified user.

        Only accessible by authenticated admins. The generated token carries
        the user's current role and permissions from .user_data.json.

        Args:
            username: The user to generate a token for.
            expire_hours: Optional custom expiration in hours. Defaults to
                the server-configured TOKEN_EXPIRE_HOURS (currently 720h = 30d).
        """
        from lightrag.api.auth import auth_handler
        import jwt as pyjwt

        users = await _read_users()
        user = _find_user(users, username)
        if not user:
            raise HTTPException(
                status_code=404, detail=f"User '{username}' not found"
            )
        if user.get("locked", False):
            raise HTTPException(
                status_code=403, detail=f"User '{username}' is locked, cannot generate token"
            )

        # Bump token_version to invalidate all previous tokens for this user.
        # We operate on the in-memory user dict (already read under _USER_DATA_LOCK)
        # and let _write_users persist everything in a single atomic write.
        # This avoids the double-write race in auth_handler.bump_token_version()
        # which reads/writes the file independently without the lock.
        new_version = user.get("token_version", 0) + 1
        user["token_version"] = new_version
        # Invalidate the in-memory cache so the next validation re-reads from file.
        auth_handler._token_version_cache.pop(username, None)

        token = auth_handler.create_token(
            username=username,
            role=user.get("role", "user"),
            custom_expire_hours=expire_hours,
            token_version=new_version,
        )

        # Decode without verification to extract exp (the token was just created)
        payload = pyjwt.decode(
            token, auth_handler.secret, algorithms=[auth_handler.algorithm]
        )
        expires_at = payload.get("exp")

        # Store token_expires_at, token_version, expire_hours, and the
        # generated token itself in the user record so /login can return
        # the admin-configured token instead of creating a new one.
        user["token_expires_at"] = expires_at
        user["token_version"] = new_version
        user["token_expire_hours"] = expire_hours or auth_handler.expire_hours
        user["login_token"] = token
        await _write_users(users)

        return {
            "access_token": token,
            "token_type": "bearer",
            "username": username,
            "role": user.get("role", "user"),
            "expires_at": expires_at,
            "expire_hours": expire_hours or auth_handler.expire_hours,
        }

    return router
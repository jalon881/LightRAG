import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  KeyRound,
  RefreshCw,
  User as UserIcon,
  Users as UsersIcon,
  UserPlus,
  Lock,
  Unlock,
  Menu,
  Pencil,
  Trash2,
  AlertCircle,
  CheckCircle2
} from 'lucide-react'
import { toast } from 'sonner'

import Button from '@/components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import Input from '@/components/ui/Input'
import Badge from '@/components/ui/Badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/Dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/Select'
import Checkbox from '@/components/ui/Checkbox'
import { useAuthStore } from '@/stores/state'
import {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  toggleLockUser,
  updateUserPermissions,
  generateUserToken,
  AVAILABLE_MENU_ITEMS,
  type UserInfo
} from '@/api/lightrag'

const MENU_LABEL_MAP: Record<string, string> = {
  dashboard: 'header.dashboard',
  'knowledge-base': 'header.knowledgeBase',
  documents: 'header.documents',
  'knowledge-graph': 'header.knowledgeGraph',
  retrieval: 'header.retrieval',
  users: 'header.users'
}

const MENU_FALLBACK_MAP: Record<string, string> = {
  dashboard: 'Dashboard',
  'knowledge-base': 'Knowledge Base',
  documents: 'Document Management',
  'knowledge-graph': 'Knowledge Graph',
  retrieval: 'Retrieval',
  users: 'User Management'
}

export default function UserManagement() {
  const { t } = useTranslation()
  const { username, isGuestMode, coreVersion, apiVersion, lastTokenRenewal, tokenExpiresAt } =
    useAuthStore()

  const [users, setUsers] = useState<UserInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showPermDialog, setShowPermDialog] = useState(false)
  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null)

  // Form state
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState('user')
  const [newPermissions, setNewPermissions] = useState<string[]>([...AVAILABLE_MENU_ITEMS])

  const [editPassword, setEditPassword] = useState('')
  const [editRole, setEditRole] = useState('user')

  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  const [saving, setSaving] = useState(false)

  // Change password state
  const [showChangePwdDialog, setShowChangePwdDialog] = useState(false)
  const [changePwdNew, setChangePwdNew] = useState('')
  const [changePwdConfirm, setChangePwdConfirm] = useState('')

  const [roleVersion, setRoleVersion] = useState(0)
  const [showToken, setShowToken] = useState(false)
  const toggleShowToken = () => setShowToken(v => !v)
  const token = useMemo(() => {
    void roleVersion
    return localStorage.getItem('LIGHTRAG-API-TOKEN') || ''
  }, [roleVersion])
  const handleCopyOwnToken = async () => {
    try {
      await navigator.clipboard.writeText(token)
      toast.success(t('userManagement.tokenCopied', '令牌已复制到剪贴板'))
    } catch {
      toast.error(t('userManagement.tokenCopyFailed', '复制失败'))
    }
  }
  const role = useMemo(() => {
    void roleVersion // depend on refresh trigger
    try {
      const token = localStorage.getItem('LIGHTRAG-API-TOKEN')
      if (!token) return null
      const payload = JSON.parse(atob(token.split('.')[1]))
      return typeof payload.role === 'string' ? payload.role : null
    } catch {
      return null
    }
  }, [roleVersion])

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getUsers()
      setUsers(result.users)
    } catch {
      toast.error(t('userManagement.loadError', 'Failed to load users'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchUsers()
  }, [fetchUsers])

  const isAdmin = role === 'admin'

  // Add user
  const handleAddUser = async () => {
    if (!newUsername.trim()) {
      toast.error(t('userManagement.usernameRequired', 'Username is required'))
      return
    }
    if (!newPassword) {
      toast.error(t('userManagement.passwordRequired', 'Password is required'))
      return
    }
    setSaving(true)
    try {
      await createUser({
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
        permissions: newPermissions
      })
      toast.success(t('userManagement.userCreated', 'User created successfully'))
      setShowAddDialog(false)
      resetAddForm()
      await fetchUsers()
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.createFailed', 'Failed to create user') + `: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  // Change own password
  const handleChangePassword = async () => {
    if (!changePwdNew) {
      toast.error(t('userManagement.passwordRequired', 'Password is required'))
      return
    }
    if (changePwdNew !== changePwdConfirm) {
      toast.error(t('userManagement.passwordsDoNotMatch', 'Passwords do not match'))
      return
    }
    setSaving(true)
    try {
      await updateUser(username!, {
        password: changePwdNew
      })
      toast.success(t('userManagement.passwordChanged', 'Password changed successfully'))
      setShowChangePwdDialog(false)
      setChangePwdNew('')
      setChangePwdConfirm('')
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.passwordChangeFailed', 'Failed to change password') + `: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const handleOpenChangePwd = () => {
    setChangePwdNew('')
    setChangePwdConfirm('')
    setShowChangePwdDialog(true)
  }

  const resetAddForm = () => {
    setNewUsername('')
    setNewPassword('')
    setNewRole('user')
    setNewPermissions([...AVAILABLE_MENU_ITEMS])
  }

  // Edit user
  const handleEditUser = async () => {
    if (!selectedUser) return
    setSaving(true)
    try {
      await updateUser(selectedUser.username, {
        password: editPassword || undefined,
        role: editRole
      })
      toast.success(t('userManagement.userUpdated', 'User updated successfully'))
      setShowEditDialog(false)
      await fetchUsers()
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.updateFailed', 'Failed to update user') + `: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const openEditDialog = (user: UserInfo) => {
    setSelectedUser(user)
    setEditPassword('')
    setEditRole(user.role)
    setShowEditDialog(true)
  }

  // Delete user
  const handleDeleteUser = async () => {
    if (!selectedUser) return
    setSaving(true)
    try {
      await deleteUser(selectedUser.username)
      toast.success(t('userManagement.userDeleted', 'User deleted successfully'))
      setShowDeleteDialog(false)
      setDeleteConfirmText('')
      await fetchUsers()
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.deleteFailed', 'Failed to delete user') + `: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const openDeleteDialog = (user: UserInfo) => {
    setSelectedUser(user)
    setDeleteConfirmText('')
    setShowDeleteDialog(true)
  }

  // Lock/unlock
  const handleToggleLock = async (user: UserInfo) => {
    try {
      await toggleLockUser(user.username, !user.locked)
      toast.success(
        user.locked
          ? t('userManagement.userUnlocked', 'User unlocked')
          : t('userManagement.userLocked', 'User locked')
      )
      await fetchUsers()
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.lockFailed', 'Failed to update lock status') + `: ${msg}`)
    }
  }

  // Permissions
  const handleOpenPermissions = (user: UserInfo) => {
    setSelectedUser(user)
    setNewPermissions([...user.permissions])
    setShowPermDialog(true)
  }

  const handleTogglePermission = (perm: string) => {
    setNewPermissions(prev =>
      prev.includes(perm)
        ? prev.filter(p => p !== perm)
        : [...prev, perm]
    )
  }

  const handleSavePermissions = async () => {
    if (!selectedUser) return
    setSaving(true)
    try {
      await updateUserPermissions(selectedUser.username, newPermissions)
      toast.success(t('userManagement.permissionsUpdated', 'Permissions updated'))
      setShowPermDialog(false)
      await fetchUsers()
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.permissionsFailed', 'Failed to update permissions') + `: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  // Generate token for a user
  const [tokenDialogUser, setTokenDialogUser] = useState<string | null>(null)
  const [generatedToken, setGeneratedToken] = useState('')
  const [genTokenExpiresAt, setGenTokenExpiresAt] = useState<number | null>(null)
  const [tokenExpireHours, setTokenExpireHours] = useState(720)
  const [tokenGenerating, setTokenGenerating] = useState(false)

  const handleGenerateToken = async (username: string) => {
    setTokenGenerating(true)
    try {
      const data = await generateUserToken(username, tokenExpireHours)
      setGeneratedToken(data.access_token)
      setGenTokenExpiresAt(data.expires_at || null)
      // If generating for the currently logged-in user, immediately
      // save and switch to the new token.  The backend already
      // invalidated the old token (bump_token_version), so any
      // subsequent request with the old token would get a 401.
      const currentUser = useAuthStore.getState().username
      if (currentUser && currentUser === username) {
        useAuthStore.getState().login(
          data.access_token,
          false,
          useAuthStore.getState().permissions,
          useAuthStore.getState().coreVersion,
          useAuthStore.getState().apiVersion,
          useAuthStore.getState().webuiTitle,
          useAuthStore.getState().webuiDescription,
          data.expires_at || undefined,
        )
      }
      setTokenDialogUser(username)
    } catch (error: any) {
      const msg = error?.response?.data?.detail || error.message
      toast.error(t('userManagement.tokenFailed', 'Failed to generate token') + `: ${msg}`)
    } finally {
      setTokenGenerating(false)
    }
  }

  // tokenExpiresAt from auth store is milliseconds; genTokenExpiresAt
  // from backend is seconds.  Normalise both to milliseconds.
  const formatExpiry = (ts: number | null) => {
    if (!ts) return ''
    const ms = ts > 1e12 ? ts : ts * 1000
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(generatedToken)
      toast.success(t('userManagement.tokenCopied', 'Token copied to clipboard'))
    } catch {
      toast.error(t('userManagement.tokenCopyFailed', 'Failed to copy'))
    }
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-6">
      {/* Page header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isAdmin
              ? t('userManagement.title', 'User Management')
              : t('userManagement.personalInfo', 'Personal Information')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {isAdmin
              ? t('userManagement.subtitle', 'Account, authentication and session information')
              : t('userManagement.personalInfoSubtitle', 'Account information and personal settings')}
          </p>
        </div>
      </header>

      {/* User list (admin only) — placed first for prominence */}
      {isAdmin && (
        <Card variant="glass" className="glass-sheen overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <UsersIcon className="text-primary size-4" aria-hidden="true" />
              {t('userManagement.userList', 'User List')}
            </CardTitle>
            <Button onClick={() => { resetAddForm(); setShowAddDialog(true) }} size="sm" className="gap-2">
              <UserPlus className="size-4" />
              {t('userManagement.addUser', 'Add User')}
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin mr-2" />
                {t('common.loading', 'Loading...')}
              </div>
            ) : users.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground text-sm">
                <UserIcon className="size-10 mb-3 opacity-40" />
                {t('userManagement.noUsers', 'No users yet')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                      <th className="pb-3 pl-2 font-medium">{t('userManagement.colUsername', 'Username')}</th>
                      <th className="pb-3 font-medium">{t('userManagement.colRole', 'Role')}</th>
                      <th className="pb-3 font-medium">{t('userManagement.colStatus', 'Status')}</th>
                      <th className="pb-3 font-medium">{t('userManagement.colPermissions', 'Permissions')}</th>
                      <th className="pb-3 font-medium">{t('userManagement.colToken', 'Token')}</th>
                      <th className="pb-3 font-medium">{t('userManagement.colTokenExpiry', 'Expiry')}</th>
                      <th className="pb-3 pr-2 text-right font-medium">{t('userManagement.colActions', 'Actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {users.map(user => (
                      <tr key={user.username} className="hover:bg-foreground/5 transition-colors">
                        <td className="py-3 pl-2">
                          <div className="flex items-center gap-2">
                            <UserIcon className="size-4 text-muted-foreground shrink-0" />
                            <span className="font-medium">{user.username}</span>
                            {user.username === username && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-cyan-500/30 text-cyan-400">
                                {t('userManagement.currentAccount', 'You')}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-3">
                          <Badge variant={user.role === 'admin' ? 'default' : user.role === 'trial' ? 'outline' : 'secondary'} className="gap-1 text-xs">
                            {user.role === 'admin' ? t('userManagement.superAdmin', 'Super Admin') : user.role === 'trial' ? t('userManagement.trialUser', 'Trial User') : t('userManagement.standardUser', 'Standard User')}
                          </Badge>
                        </td>
                        <td className="py-3">
                          {user.locked ? (
                            <Badge variant="destructive" className="gap-1 text-xs">
                              <Lock className="size-3" />
                              {t('userManagement.locked', 'Locked')}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="gap-1 text-xs border-emerald-500/30 text-emerald-400">
                              <CheckCircle2 className="size-3" />
                              {t('userManagement.active', 'Active')}
                            </Badge>
                          )}
                        </td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-1">
                            {user.permissions.slice(0, 3).map(perm => (
                              <Badge key={perm} variant="outline" className="text-[10px] px-1.5 py-0">
                                {t(MENU_LABEL_MAP[perm] || perm, MENU_FALLBACK_MAP[perm] || perm)}
                              </Badge>
                            ))}
                            {user.permissions.length > 3 && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                +{user.permissions.length - 3}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-3">
                          {user.login_token ? (
                            <code
                              className="bg-muted/30 text-[11px] px-1.5 py-0.5 rounded cursor-default select-all"
                              title={user.login_token}
                            >
                              {user.login_token.substring(0, 16)}...
                            </code>
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </td>
                        <td className="py-3">
                          {user.token_expires_at ? (
                            <span className="text-xs">
                              {formatExpiry(user.token_expires_at * 1000)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </td>
                        <td className="py-3 pr-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditDialog(user)}
                              title={t('userManagement.editUser', 'Edit User')}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleToggleLock(user)}
                              title={
                                user.locked
                                  ? t('userManagement.unlockUser', 'Unlock User')
                                  : t('userManagement.lockUser', 'Lock User')
                              }
                              disabled={user.username === 'admin'}
                            >
                              {user.locked ? (
                                <Unlock className="size-3.5 text-emerald-400" />
                              ) : (
                                <Lock className="size-3.5 text-amber-400" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenPermissions(user)}
                              title={t('userManagement.managePermissions', 'Manage Permissions')}
                            >
                              <Menu className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => { setTokenExpireHours(user.role === 'admin' ? 8760 : 720); handleGenerateToken(user.username) }}
                              title={t('userManagement.generateToken', 'Generate Token')}
                              disabled={tokenGenerating || user.locked}
                            >
                              <KeyRound className="size-3.5 text-cyan-400" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openDeleteDialog(user)}
                              title={t('userManagement.deleteUser', 'Delete User')}
                              disabled={user.username === 'admin'}
                              className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Account details + system info */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card variant="glass" className="glass-sheen">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="text-primary size-4" aria-hidden="true" />
              {t('userManagement.accountInfo', 'Account Information')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-border/50 divide-y">
              <InfoRow
                label={t('login.username', 'Username')}
                value={username}
                mono
              />
              <InfoRow
                label={t('userManagement.authMode', 'Authentication Mode')}
                value={
                  isGuestMode
                    ? t('login.guestMode', 'Login Free')
                    : t('userManagement.authEnabled', 'Enabled')
                }
              />
              <InfoRow
                label={t('userManagement.role', 'Role')}
                value={role === 'admin' ? t('userManagement.superAdmin', 'Super Admin') : role === 'trial' ? t('userManagement.trialUser', 'Trial User') : role === 'user' ? t('userManagement.standardUser', 'Standard User') : (role || t('userManagement.roleUnknown', 'unknown'))}
                mono
              />
              <InfoRow
                label={t('userManagement.tokenExpires', 'Token Expires')}
                value={formatExpiry(tokenExpiresAt)}
              />
              <InfoRow
                label={t('userManagement.lastRenewal', 'Last Token Renewal')}
                value={lastTokenRenewal}
              />
            </div>
            {!isGuestMode && (
              <div className="mt-3 border-t pt-3">
                <button
                  onClick={toggleShowToken}
                  className="text-primary text-xs font-medium hover:underline"
                >
                  {showToken
                    ? t('userManagement.hideToken', '收起令牌')
                    : t('userManagement.showToken', '查看令牌')}
                </button>
                {showToken && (
                  <div className="mt-2 space-y-2">
                    <div className="bg-muted/30 relative rounded-lg p-3">
                      <pre className="text-[11px] break-all whitespace-pre-wrap font-mono select-all leading-relaxed">{token}</pre>
                    </div>
                    <Button
                      onClick={handleCopyOwnToken}
                      variant="outline"
                      size="sm"
                      className="gap-2"
                    >
                      {t('userManagement.copyToken', 'Copy Token')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {!isGuestMode && (
              <div className="mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenChangePwd}
                  className="gap-2"
                >
                  <KeyRound className="size-3.5" />
                  {t('userManagement.changePassword', 'Change Password')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="glass" className="glass-sheen">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="text-primary size-4" aria-hidden="true" />
              {t('userManagement.systemInfo', 'System Information')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-border/50 divide-y">
              <InfoRow
                label={t('dashboard.version', 'Version')}
                value={
                  coreVersion && apiVersion
                    ? `${coreVersion} / ${apiVersion}`
                    : coreVersion || apiVersion
                }
                mono
              />
              <InfoRow
                label={t('userManagement.coreVersion', 'Core Version')}
                value={coreVersion}
                mono
              />
              <InfoRow
                label={t('userManagement.apiVersion', 'API Version')}
                value={apiVersion}
                mono
              />
            </div>
            <div className="text-muted-foreground mt-4 flex items-center gap-2 text-xs">
              <UserIcon className="size-3.5" aria-hidden="true" />
              {t('userManagement.sessionHint', 'Session data is stored locally in this browser')}
            </div>
          </CardContent>
        </Card>
      </div>


      {/* Add User Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('userManagement.addUser', 'Add User')}</DialogTitle>
            <DialogDescription>
              {t('userManagement.addUserDesc', 'Create a new user account')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.username', 'Username')}
              </label>
              <Input
                placeholder={t('userManagement.usernamePlaceholder', 'Enter username')}
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.password', 'Password')}
              </label>
              <Input
                type="password"
                placeholder={t('userManagement.passwordPlaceholder', 'Enter password')}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.role', 'Role')}
              </label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger>
                  <SelectValue placeholder={t('userManagement.selectRole', 'Select role')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('userManagement.standardUser', 'Standard User')}</SelectItem>
                  <SelectItem value="trial">{t('userManagement.trialUser', 'Trial User')}</SelectItem>
                  <SelectItem value="admin">{t('userManagement.superAdmin', 'Super Admin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.menuPermissions', 'Menu Permissions')}
              </label>
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
                {AVAILABLE_MENU_ITEMS.map(perm => (
                  <label key={perm} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={newPermissions.includes(perm)}
                      onCheckedChange={() => handleTogglePermission(perm)}
                    />
                    {t(MENU_LABEL_MAP[perm], MENU_FALLBACK_MAP[perm])}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddDialog(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleAddUser} disabled={saving}>
              {saving ? t('common.saving', 'Saving...') : t('userManagement.create', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('userManagement.editUser', 'Edit User')}: {selectedUser?.username}
            </DialogTitle>
            <DialogDescription>
              {t('userManagement.editUserDesc', 'Update user password or role')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.newPassword', 'New Password')}
              </label>
              <Input
                type="password"
                placeholder={t('userManagement.passwordLeaveEmpty', 'Leave empty to keep current')}
                value={editPassword}
                onChange={e => setEditPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.role', 'Role')}
              </label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('userManagement.standardUser', 'Standard User')}</SelectItem>
                  <SelectItem value="trial">{t('userManagement.trialUser', 'Trial User')}</SelectItem>
                  <SelectItem value="admin">{t('userManagement.superAdmin', 'Super Admin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowEditDialog(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleEditUser} disabled={saving}>
              {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-400">
              <AlertCircle className="size-5" />
              {t('userManagement.deleteUser', 'Delete User')}
            </DialogTitle>
            <DialogDescription>
              {t('userManagement.deleteUserDesc', 'Are you sure you want to delete this user? This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm font-medium mb-4">
              {t('userManagement.deleteUserConfirm', 'Type the username to confirm')}: <strong>{selectedUser?.username}</strong>
            </p>
            <Input
              placeholder={t('userManagement.deleteUserPlaceholder', 'Type username to confirm')}
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeleteDialog(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={deleteConfirmText !== selectedUser?.username || saving}
            >
              {saving ? t('common.saving', 'Saving...') : t('userManagement.delete', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Permissions Dialog */}
      <Dialog open={showPermDialog} onOpenChange={setShowPermDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Menu className="size-5" />
              {t('userManagement.managePermissions', 'Manage Permissions')}: {selectedUser?.username}
            </DialogTitle>
            <DialogDescription>
              {t('userManagement.permissionsDesc', 'Select which menu items this user can access')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <div className="grid grid-cols-2 gap-3 rounded-md border p-4">
              {AVAILABLE_MENU_ITEMS.map(perm => (
                <label key={perm} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={newPermissions.includes(perm)}
                    onCheckedChange={() => handleTogglePermission(perm)}
                  />
                  {t(MENU_LABEL_MAP[perm], MENU_FALLBACK_MAP[perm])}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowPermDialog(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleSavePermissions} disabled={saving}>
              {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Password Dialog */}
      <Dialog open={showChangePwdDialog} onOpenChange={setShowChangePwdDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5" />
              {t('userManagement.changePassword', 'Change Password')}
            </DialogTitle>
            <DialogDescription>
              {t('userManagement.changePasswordDesc', 'Change the password for your account')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.newPassword', 'New Password')}
              </label>
              <Input
                type="password"
                placeholder={t('userManagement.passwordPlaceholder', 'Enter new password')}
                value={changePwdNew}
                onChange={e => setChangePwdNew(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('userManagement.confirmPassword', 'Confirm Password')}
              </label>
              <Input
                type="password"
                placeholder={t('userManagement.confirmPassword', 'Confirm new password')}
                value={changePwdConfirm}
                onChange={e => setChangePwdConfirm(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowChangePwdDialog(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleChangePassword} disabled={saving}>
              {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token generation dialog */}
      <Dialog open={!!tokenDialogUser} onOpenChange={(o) => { if (!o) { setTokenDialogUser(null); setGeneratedToken(''); setGenTokenExpiresAt(null) } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-cyan-400" />
              {t('userManagement.tokenTitle', 'Access Token')} — {tokenDialogUser}
            </DialogTitle>
            <DialogDescription>
              {t('userManagement.tokenDescription', 'Use this token in the Authorization header for API requests.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium">{t('userManagement.tokenExpireHours', '有效期')}:</label>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {[
                  { label: t('userManagement.expire1Month', '1个月'), hours: 720 },
                  { label: t('userManagement.expire3Month', '3个月'), hours: 2160 },
                  { label: t('userManagement.expire6Month', '6个月'), hours: 4320 },
                  { label: t('userManagement.expire1Year', '1年'), hours: 8760 },
                  { label: t('userManagement.expireLong', '长期'), hours: 876000 },
                ].map((p) => (
                  <button
                    key={p.hours}
                    onClick={() => setTokenExpireHours(p.hours)}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                      tokenExpireHours === p.hours
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted/30 text-muted-foreground hover:bg-foreground/10'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={1}
                value={tokenExpireHours}
                onChange={(e) => setTokenExpireHours(Number(e.target.value) || 720)}
                className="w-24 text-xs"
              />
              <span className="text-muted-foreground text-xs">{t('userManagement.hours', '小时')}</span>
              <Button onClick={() => handleGenerateToken(tokenDialogUser!)} disabled={tokenGenerating} size="sm">
                {tokenGenerating ? t('userManagement.tokenGenerating', '生成中...') : t('userManagement.generateToken', '生成令牌')}
              </Button>
            </div>
            {genTokenExpiresAt && (
              <div className="text-muted-foreground text-xs">
                {t('userManagement.tokenExpires', '过期时间')}: {formatExpiry(genTokenExpiresAt)}
              </div>
            )}
            {generatedToken && (
              <>
                <div className="bg-muted/30 relative rounded-lg p-4">
                  <pre className="text-xs break-all whitespace-pre-wrap font-mono select-all">{generatedToken}</pre>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleCopyToken} variant="outline" size="sm" className="gap-2 flex-1">
                    {t('userManagement.copyToken', 'Copy Token')}
                  </Button>
                  {tokenDialogUser === useAuthStore.getState().username ? (
                    <Button
                      onClick={() => {
                        useAuthStore.getState().login(
                          generatedToken,
                          false,
                          useAuthStore.getState().permissions,
                          useAuthStore.getState().coreVersion,
                          useAuthStore.getState().apiVersion,
                          useAuthStore.getState().webuiTitle,
                          useAuthStore.getState().webuiDescription,
                          genTokenExpiresAt,  // Pass server-provided expires_at
                        )
                        setRoleVersion(v => v + 1)
                        toast.success(t('userManagement.tokenSaved', '令牌已保存并生效'))
                        setTokenDialogUser(null)
                        setGeneratedToken('')
                        setGenTokenExpiresAt(null)
                      }}
                      size="sm"
                      className="gap-2"
                    >
                      {t('userManagement.saveToken', '保存并使用')}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => {
                        toast.success(t('userManagement.tokenSaved', '令牌已保存'))
                        setTokenDialogUser(null)
                        setGeneratedToken('')
                        setGenTokenExpiresAt(null)
                      }}
                      size="sm"
                      className="gap-2"
                    >
                      {t('userManagement.saveTokenDone', '保存')}
                    </Button>
                  )}
                </div>
                <div className="text-muted-foreground text-xs">
                  <p>{t('userManagement.tokenUsage', 'Usage')}:</p>
                  <code className="bg-muted/30 mt-1 block rounded px-2 py-1 text-xs">
                    Authorization: Bearer {generatedToken.substring(0, 25)}...
                  </code>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setTokenDialogUser(null); setGeneratedToken(''); setGenTokenExpiresAt(null) }}>
              {t('common.close', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface InfoRowProps {
  label: string
  value?: string | null
  mono?: boolean
}

function InfoRow({ label, value, mono }: InfoRowProps) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <span
        className={`truncate text-right text-xs font-medium ${mono ? 'font-mono' : ''}`}
        title={String(value)}
      >
        {String(value)}
      </span>
    </div>
  )
}
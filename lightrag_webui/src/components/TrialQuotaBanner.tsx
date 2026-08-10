import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/state'
import { getUsers, type UserInfo } from '@/api/lightrag'
import { AlertTriangle } from 'lucide-react'

/** Parse role from the JWT token stored in localStorage. */
function useRole(): string | null {
  return useMemo(() => {
    try {
      const token = localStorage.getItem('LIGHTRAG-API-TOKEN')
      if (!token) return null
      const payload = JSON.parse(atob(token.split('.')[1]))
      return typeof payload.role === 'string' ? payload.role : null
    } catch { return null }
  }, [])
}

/**
 * Displays a prominent quota banner for trial users above document upload areas.
 * Shows nothing for admin / standard users.
 */
export default function TrialQuotaBanner() {
  const { t } = useTranslation()
  const role = useRole()
  const username = useAuthStore((s) => s.username)
  const [quota, setQuota] = useState<number | null>(null)
  const [used, setUsed] = useState<number>(0)

  useEffect(() => {
    if (role !== 'trial' || !username) return
    let cancelled = false
    getUsers()
      .then((res) => {
        if (cancelled) return
        const me = res.users.find((u: UserInfo) => u.username === username)
        if (me && me.documents_quota != null) {
          setQuota(me.documents_quota)
          setUsed(me.documents_used ?? 0)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [role, username])

  if (role !== 'trial' || quota == null) return null

  const remaining = quota - used
  const exhausted = remaining <= 0

  return (
    <div
      className={`mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
        exhausted
          ? 'border-red-500/40 bg-red-500/10 text-red-300'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      }`}
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span>
        {exhausted
          ? t('documentPanel.quotaExhaustedBanner', 'Upload quota exhausted ({{used}}/{{quota}}). Contact admin to upgrade.', { used, quota })
          : t('documentPanel.quotaRemainingBanner', 'Trial account: {{remaining}} of {{quota}} uploads remaining', { remaining, quota })}
      </span>
    </div>
  )
}

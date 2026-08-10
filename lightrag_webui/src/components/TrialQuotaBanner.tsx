import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getMyQuota } from '@/api/lightrag'
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
 * Re-fetches quota after each successful upload via the custom "quota-refresh" event
 * that UploadDocumentsDialog dispatches.
 */
export default function TrialQuotaBanner() {
  const { t } = useTranslation()
  const role = useRole()
  const [quota, setQuota] = useState<number | null>(null)
  const [used, setUsed] = useState<number>(0)
  const [refreshKey, setRefreshKey] = useState(0)

  const fetchQuota = useCallback(() => {
    getMyQuota()
      .then((res) => {
        if (res.documents_quota != null) {
          setQuota(res.documents_quota)
          setUsed(res.documents_used ?? 0)
        }
      })
      .catch(() => {})
  }, [])

  // Initial fetch
  useEffect(() => {
    if (role !== 'trial') return
    fetchQuota()
  }, [role, fetchQuota, refreshKey])

  // Listen for upload-complete events to refresh the counter
  useEffect(() => {
    const handler = () => setRefreshKey(k => k + 1)
    window.addEventListener('quota-refresh', handler)
    return () => window.removeEventListener('quota-refresh', handler)
  }, [])

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
          : t('documentPanel.quotaRemainingBanner', 'Trial account: {{used}}/{{quota}} uploads used ({{remaining}} remaining)', { used, quota, remaining })}
      </span>
    </div>
  )
}

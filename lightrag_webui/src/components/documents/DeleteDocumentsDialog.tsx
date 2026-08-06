import { useState, useCallback, useEffect, useRef } from 'react'
import Button from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter
} from '@/components/ui/Dialog'
import Input from '@/components/ui/Input'
import Progress from '@/components/ui/Progress'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import { deleteDocuments, deleteKnowledgeBaseDocuments, getPipelineStatus } from '@/api/lightrag'

import { TrashIcon, AlertTriangleIcon, CheckCircle2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// Simple Label component
const Label = ({
  htmlFor,
  className,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label
    htmlFor={htmlFor}
    className={className}
    {...props}
  >
    {children}
  </label>
)

type DeletionPhase = 'confirm' | 'initiating' | 'tracking' | 'completed'

interface DeleteDocumentsDialogProps {
  selectedDocIds: string[]
  /** Per-document KB id mapping so deletes route to the correct workspace */
  docKbIds?: Record<string, string | undefined>
  onDocumentsDeleted?: () => Promise<void>
  /** Knowledge base id to scope the delete to; global delete when omitted */
  kbId?: string
}

export default function DeleteDocumentsDialog({
  selectedDocIds,
  docKbIds,
  onDocumentsDeleted,
  kbId
}: DeleteDocumentsDialogProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleteFile, setDeleteFile] = useState(false)
  const [deleteLLMCache, setDeleteLLMCache] = useState(false)

  // Deletion progress state
  const [phase, setPhase] = useState<DeletionPhase>('confirm')
  const [progressCur, setProgressCur] = useState(0)
  const [progressTotal, setProgressTotal] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [historyMessages, setHistoryMessages] = useState<string[]>([])

  // Track success/fail counts from history
  const [succeededCount, setSucceededCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)

  // Staleness detection: if progressCur hasn't changed in 30s, warn
  const lastProgressCurRef = useRef(0)
  const lastProgressTimeRef = useRef(0) // Set to actual time when tracking starts
  const stalledWarnedRef = useRef(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Ref mirror of progressTotal so the polling effect doesn't need it in deps
  const progressTotalRef = useRef(0)

  // Keep a ref to the latest onDocumentsDeleted so the polling effect
  // (which runs via setInterval with a stable closure) always calls
  // the current callback, not a stale one.
  const onDocumentsDeletedRef = useRef(onDocumentsDeleted)
  useEffect(() => {
    onDocumentsDeletedRef.current = onDocumentsDeleted
  })

  const isConfirmEnabled = confirmText.toLowerCase() === 'yes' && phase !== 'initiating' && phase !== 'tracking'

  // Cleanup polling on unmount or close
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  // Reset state when dialog closes
  const handleOpenChange = useCallback((newOpen: boolean) => {
    setOpen(newOpen)
    if (!newOpen) {
      stopPolling()
      setConfirmText('')
      setDeleteFile(false)
      setDeleteLLMCache(false)
      setPhase('confirm')
      setProgressCur(0)
      setProgressTotal(0)
      setProgressMessage('')
      setHistoryMessages([])
      setSucceededCount(0)
      setFailedCount(0)
      stalledWarnedRef.current = false
    }
  }, [stopPolling])

  // Poll pipeline status during tracking phase
  useEffect(() => {
    if (phase !== 'tracking' || !open) return

    const fetchProgress = async () => {
      try {
        const status = await getPipelineStatus(kbId || undefined)

        // Verify this is still our delete job by checking job_name
        const isDeleteJob = status.job_name &&
          (status.job_name.toLowerCase().includes('deleting') ||
           status.job_name.toLowerCase().includes('delete'))

        if (!status.busy || !isDeleteJob) {
          // Deletion complete (busy flipped to false) or job changed
          stopPolling()
          setPhase('completed')
          // Mark remaining docs as succeeded if busy=false cleanly
          const curTotal = progressTotalRef.current
          if (!status.busy && curTotal > 0) {
            setProgressCur(curTotal)
          }
          return
        }

        // Update progress
        const cur = status.cur_batch ?? 0
        const total = status.batchs ?? selectedDocIds.length
        setProgressCur(cur)
        setProgressTotal(total)
        setProgressMessage(status.latest_message ?? '')

        // Update history and counts
        if (status.history_messages && status.history_messages.length > 0) {
          setHistoryMessages(status.history_messages)

          // Count successes and failures from history
          let succeeded = 0
          let failed = 0
          for (const msg of status.history_messages) {
            if (msg.toLowerCase().includes('success') || msg.toLowerCase().includes('deleted')) {
              succeeded++
            } else if (msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error')) {
              failed++
            }
          }
          setSucceededCount(succeeded)
          setFailedCount(failed)
        }

        // Check for staleness: no progress change in 30s
        if (cur === lastProgressCurRef.current) {
          if (Date.now() - lastProgressTimeRef.current > 30000 && !stalledWarnedRef.current) {
            stalledWarnedRef.current = true
            toast.warning(t('documentPanel.deleteDocuments.stalled'))
          }
        } else {
          lastProgressCurRef.current = cur
          lastProgressTimeRef.current = Date.now()
        }
      } catch {
        // Polling failed silently — keep showing last known progress
      }
    }

    // Initial fetch
    fetchProgress()
    // Poll every 2s
    pollIntervalRef.current = setInterval(fetchProgress, 2000)

    return () => {
      stopPolling()
    }
  }, [phase, open, kbId, selectedDocIds.length, t, stopPolling])

  const handleDelete = useCallback(async () => {
    if (!isConfirmEnabled || selectedDocIds.length === 0) return

    setPhase('initiating')
    try {
      // Scoped deletes route through the KB endpoint
      if (kbId) {
        const result = await deleteKnowledgeBaseDocuments(kbId, selectedDocIds, false, {
          deleteFile,
          deleteLlmCache: deleteLLMCache
        })
        if (result.status === 'deletion_started') {
          setPhase('tracking')
          setProgressTotal(selectedDocIds.length)
          progressTotalRef.current = selectedDocIds.length
          lastProgressCurRef.current = 0
          lastProgressTimeRef.current = Date.now()
          return
        }
        if (result.status === 'busy') {
          toast.error(t('documentPanel.deleteDocuments.busy'))
          setPhase('confirm')
          return
        }
        toast.error(t('documentPanel.deleteDocuments.failed', { message: result.message }))
        setPhase('confirm')
        return
      }

      // Global view: group selected docs by kb_id, send a KB-scoped delete for each group
      const byKb = new Map<string, string[]>()
      for (const docId of selectedDocIds) {
        const docKb = (docKbIds || {})[docId] || ''
        const existing = byKb.get(docKb)
        if (existing) {
          existing.push(docId)
        } else {
          byKb.set(docKb, [docId])
        }
      }
      let anyFailed = false
      for (const [workspace, ids] of byKb) {
        const result = workspace
          ? await deleteKnowledgeBaseDocuments(workspace, ids, false, {
            deleteFile,
            deleteLlmCache: deleteLLMCache
          })
          : await deleteDocuments(ids, deleteFile, deleteLLMCache, workspace)
        if (result.status !== 'deletion_started' && result.status !== 'busy') {
          anyFailed = true
          toast.error(t('documentPanel.deleteDocuments.failed', { message: result.message }))
        }
      }
      if (anyFailed) {
        setPhase('confirm')
        return
      }
      // All started, switch to tracking
      setPhase('tracking')
      setProgressTotal(selectedDocIds.length)
      progressTotalRef.current = selectedDocIds.length
      lastProgressCurRef.current = 0
      lastProgressTimeRef.current = Date.now()
    } catch (err) {
      toast.error(t('documentPanel.deleteDocuments.error', { error: errorMessage(err) }))
      setPhase('confirm')
    }
  }, [isConfirmEnabled, selectedDocIds, deleteFile, deleteLLMCache, kbId, t, docKbIds])

  const handleCloseComplete = useCallback(async () => {
    stopPolling()
    // Refresh parent list before closing dialog.
    // Use ref to always call the latest callback.
    const callback = onDocumentsDeletedRef.current
    if (callback) {
      await callback()
    }
    toast.success(t('documentPanel.deleteDocuments.success', { count: selectedDocIds.length }))
    handleOpenChange(false)
  }, [stopPolling, t, selectedDocIds.length, handleOpenChange])

  const pct = progressTotal > 0 ? Math.round((progressCur / progressTotal) * 100) : 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="destructive"
          side="bottom"
          tooltip={t('documentPanel.deleteDocuments.tooltip', { count: selectedDocIds.length })}
          size="sm"
        >
          <TrashIcon/> {t('documentPanel.deleteDocuments.button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        {/* --- Confirm Phase --- */}
        {phase === 'confirm' || phase === 'initiating' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-500 dark:text-red-400 font-bold">
                <AlertTriangleIcon className="h-5 w-5" />
                {t('documentPanel.deleteDocuments.title')}
              </DialogTitle>
              <DialogDescription className="pt-2">
                {t('documentPanel.deleteDocuments.description', { count: selectedDocIds.length })}
              </DialogDescription>
            </DialogHeader>

            <div className="text-red-500 dark:text-red-400 font-semibold mb-4">
              {t('documentPanel.deleteDocuments.warning')}
            </div>

            <div className="mb-4">
              {t('documentPanel.deleteDocuments.confirm', { count: selectedDocIds.length })}
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="confirm-text" className="text-sm font-medium">
                  {t('documentPanel.deleteDocuments.confirmPrompt')}
                </Label>
                <Input
                  id="confirm-text"
                  value={confirmText}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmText(e.target.value)}
                  placeholder={t('documentPanel.deleteDocuments.confirmPlaceholder')}
                  className="w-full"
                  disabled={phase === 'initiating'}
                />
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="delete-file"
                  checked={deleteFile}
                  onChange={(e) => setDeleteFile(e.target.checked)}
                  disabled={phase === 'initiating'}
                  className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                />
                <Label htmlFor="delete-file" className="text-sm font-medium cursor-pointer">
                  {t('documentPanel.deleteDocuments.deleteFileOption')}
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="delete-llm-cache"
                  checked={deleteLLMCache}
                  onChange={(e) => setDeleteLLMCache(e.target.checked)}
                  disabled={phase === 'initiating'}
                  className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                />
                <Label htmlFor="delete-llm-cache" className="text-sm font-medium cursor-pointer">
                  {t('documentPanel.deleteDocuments.deleteLLMCacheOption')}
                </Label>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={phase === 'initiating'}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleDelete()}
                disabled={!isConfirmEnabled}
              >
                {phase === 'initiating'
                  ? t('documentPanel.deleteDocuments.tracking', 'Deleting...')
                  : t('documentPanel.deleteDocuments.confirmButton')
                }
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {/* --- Tracking / Completed Phase --- */}
        {(phase === 'tracking' || phase === 'completed') ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {phase === 'completed' ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <TrashIcon className="h-5 w-5 text-red-500 animate-pulse" />
                )}
                {phase === 'completed'
                  ? t('documentPanel.deleteDocuments.progressCompleted')
                  : t('documentPanel.deleteDocuments.progressTitle')
                }
              </DialogTitle>
              <DialogDescription className="pt-2">
                {t('documentPanel.deleteDocuments.deletingDoc', {
                  current: progressCur,
                  total: progressTotal
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Progress bar */}
              <Progress
                value={pct}
                className={phase === 'completed' ? '[&>div]:bg-green-500' : ''}
              />

              {/* Status message */}
              <p className="text-sm text-muted-foreground text-center">
                {progressMessage || t('documentPanel.deleteDocuments.tracking')}
              </p>

              {/* Completion counts */}
              {phase === 'completed' && (
                <div className="flex justify-center gap-4 text-sm">
                  <span className="text-green-600 dark:text-green-400">
                    {t('documentPanel.deleteDocuments.completedCount', {
                      count: succeededCount > 0 ? succeededCount : selectedDocIds.length,
                      total: selectedDocIds.length
                    })}
                  </span>
                  {failedCount > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      {t('documentPanel.deleteDocuments.failedCount', {
                        count: failedCount,
                        total: selectedDocIds.length
                      })}
                    </span>
                  )}
                </div>
              )}

              {/* Per-document history (scrollable) */}
              {historyMessages.length > 0 && (
                <div className="max-h-[160px] overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs space-y-0.5">
                  {historyMessages.map((msg, i) => {
                    const isSuccess = msg.toLowerCase().includes('success') || msg.toLowerCase().includes('deleted')
                    const isFail = msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error')
                    return (
                      <div key={i} className="flex items-start gap-1.5">
                        {isSuccess ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                        ) : isFail ? (
                          <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <span className="text-muted-foreground">{msg}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <DialogFooter>
              {phase === 'tracking' ? (
                <Button variant="outline" onClick={() => handleOpenChange(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
              ) : (
                <Button variant="default" onClick={handleCloseComplete}>
                  {t('documentPanel.deleteDocuments.progressClose')}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

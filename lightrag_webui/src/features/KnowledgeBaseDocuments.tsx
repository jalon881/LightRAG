import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  XCircle
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import Button from '@/components/ui/Button'
import Checkbox from '@/components/ui/Checkbox'
import { Card } from '@/components/ui/Card'
import TrialQuotaBanner from '@/components/TrialQuotaBanner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/Table'
import PaginationControls from '@/components/ui/PaginationControls'
import {
  getKnowledgeBaseDocuments,
  getDocumentDownloadUrl,
  type KnowledgeBaseDocument
} from '@/api/lightrag'
import DocxPreviewModal from '@/components/documents/DocxPreviewModal'
import DeleteDocumentsDialog from '@/components/documents/DeleteDocumentsDialog'

interface KnowledgeBaseDocumentsProps {
  kbId: string
  onUploadClick?: () => void
}

type FilterKey = 'all' | 'completed' | 'processing' | 'failed'

function statusTone(
  status: string
): 'success' | 'warning' | 'danger' | 'neutral' {
  const s = status.toLowerCase()
  if (s.includes('complet') || s.includes('succeed') || s === 'processed')
    return 'success'
  if (s.includes('fail') || s.includes('error')) return 'danger'
  if (
    s.includes('process') ||
    s.includes('pending') ||
    s.includes('parsing') ||
    s.includes('analyzing')
  )
    return 'warning'
  return 'neutral'
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status)
  const map = {
    success: 'bg-emerald-500/12 text-emerald-400 ring-emerald-500/22',
    warning: 'bg-amber-500/12 text-amber-400 ring-amber-500/22',
    danger: 'bg-rose-500/12 text-rose-400 ring-rose-500/22',
    neutral: 'bg-slate-500/12 text-slate-300 ring-slate-500/22'
  } as const
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        map[tone]
      )}
    >
      {tone === 'success' && <CheckCircle2 className="size-3" />}
      {tone === 'warning' && <LoaderCircle className="size-3" />}
      {tone === 'danger' && <XCircle className="size-3" />}
      {tone === 'neutral' && <FileText className="size-3" />}
      {status}
    </span>
  )
}

function formatBytes(bytes: number): string {
  if (!bytes) return '-'
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    sizes.length - 1
  )
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`
}

function formatTime(value?: string | null): string {
  if (!value) return '-'
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  return d.toLocaleString()
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * Document browser for a single knowledge base. Matches the reference
 * screenshot: a filter row (全部 / 已完成 / 处理中 / 失败), a search box,
 * refresh + upload actions, and a compact table with per-row delete.
 */
export default function KnowledgeBaseDocuments({
  kbId,
  onUploadClick
}: KnowledgeBaseDocumentsProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = React.useState<FilterKey>('all')
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)

  const [items, setItems] = React.useState<KnowledgeBaseDocument[]>([])
  const [total, setTotal] = React.useState(0)
  const [statusCounts, setStatusCounts] = React.useState<Record<string, number>>({})
  const [loading, setLoading] = React.useState(true)
  const [previewDoc, setPreviewDoc] = React.useState<{ id: string; name: string } | null>(null)

  // Row selection for batch delete. Only current-page rows can be selected;
  // the header checkbox toggles the whole page at once.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())

  // Initial load + reload when page/filter/search changes. The cancelled flag
  // prevents setState after unmount (matches the app-wide data-fetching
  // convention). Search submits by flipping `page` back to 1 and re-running
  // this effect via `reloadToken`.
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (cancelled) return
      setLoading(true)
      try {
        const status =
          filter === 'all'
            ? undefined
            : filter === 'completed'
              ? 'processed'
              : filter
        const data = await getKnowledgeBaseDocuments(kbId, {
          page,
          pageSize,
          status,
          search: search.trim() || undefined
        })
        if (cancelled) return
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setStatusCounts(data.status_counts ?? {})
      } catch (err) {
        if (!cancelled)
          toast.error(errorMessage(err) || t('kbDetail.loadError', 'Failed to load documents'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [kbId, page, pageSize, filter, search, t, reloadToken])

  const submitSearch = () => {
    setPage(1)
    setReloadToken((v) => v + 1)
  }

  const refresh = () => setReloadToken((v) => v + 1)

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const pageAllSelected = items.length > 0 && items.every((d) => selectedIds.has(d.id))
  const pageSomeSelected = items.some((d) => selectedIds.has(d.id))

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (pageAllSelected) {
        for (const d of items) next.delete(d.id)
      } else {
        for (const d of items) next.add(d.id)
      }
      return next
    })
  }

  // `status_counts` carries an extra `all` summary key alongside the per-status
  // counts, so summing it blindly would double the total; the server-side
  // `total` is the authoritative document count.
  const allCount = total
  const completedCount = statusCounts['processed'] ?? 0

  const filterPills: { key: FilterKey; label: string; count: number }[] = [
    { key: 'all', label: t('kbDetail.filter.all', 'All'), count: allCount },
    {
      key: 'completed',
      label: t('kbDetail.filter.completed', 'Completed'),
      count: completedCount
    },
    {
      key: 'processing',
      label: t('kbDetail.filter.processing', 'Processing'),
      count: (statusCounts['processing'] ?? 0) + (statusCounts['parsing'] ?? 0) + (statusCounts['analyzing'] ?? 0)
    },
    { key: 'failed', label: t('kbDetail.filter.failed', 'Failed'), count: statusCounts['failed'] ?? 0 }
  ]

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-4">
      <TrialQuotaBanner />
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="bg-muted/40 flex items-center gap-2 rounded-md px-3 py-2">
          <Search className="text-muted-foreground size-4" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch()
            }}
            placeholder={t('kbDetail.searchPlaceholder', 'Search file name')}
            className="bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          {t('kbDetail.refresh', 'Refresh')}
        </Button>
        {onUploadClick && (
          <Button size="sm" onClick={onUploadClick} className="gap-2">
            <Plus className="size-4" />
            {t('kbDetail.uploadDocument', 'Upload Document')}
          </Button>
        )}
        {selectedIds.size > 0 && (
          <DeleteDocumentsDialog
            selectedDocIds={[...selectedIds]}
            kbId={kbId}
            onDocumentsDeleted={async () => {
              setSelectedIds(new Set())
              refresh()
            }}
          />
        )}
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        {filterPills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            onClick={() => {
              setFilter(pill.key)
              setPage(1)
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors',
              filter === pill.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/40 text-muted-foreground hover:bg-muted/70'
            )}
          >
            {pill.label}
            <span
              className={cn(
                'text-xs',
                filter === pill.key ? 'text-primary-foreground/80' : 'text-muted-foreground/70'
              )}
            >
              {pill.count}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <Card variant="glass" className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label={t('kbDetail.selectAll', 'Select all')}
                  checked={
                    pageAllSelected ? true : pageSomeSelected ? 'indeterminate' : false
                  }
                  onCheckedChange={toggleSelectAll}
                />
              </TableHead>
              <TableHead>{t('kbDetail.colFile', 'File Name')}</TableHead>
              <TableHead>{t('kbDetail.colStatus', 'Status')}</TableHead>
              <TableHead className="text-right">{t('kbDetail.colChunks', 'Chunks')}</TableHead>
              <TableHead className="text-right">{t('kbDetail.colSize', 'Size')}</TableHead>
              <TableHead>{t('kbDetail.colUpdated', 'Updated')}</TableHead>
              <TableHead className="text-right">{t('kbDetail.colActions', 'Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-40 text-center">
                  <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground h-40 text-center">
                  {t('kbDetail.noDocs', 'No documents yet.')}
                </TableCell>
              </TableRow>
            ) : (
              items.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={t('kbDetail.selectRow', 'Select')}
                      checked={selectedIds.has(doc.id)}
                      onCheckedChange={() => toggleSelect(doc.id)}
                    />
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate font-medium" title={doc.file_name}>
                    <span className="flex items-center gap-2">
                      <FileText className="text-muted-foreground size-4 shrink-0" />
                      {doc.file_name}
                      {doc.file_name && (
                        <>
                          <button
                            title="预览源文件"
                            className="text-muted-foreground hover:text-cyan-400 shrink-0"
                            onClick={(e) => { e.stopPropagation(); setPreviewDoc({ id: doc.id, name: doc.file_name }) }}
                          >
                            <ExternalLink className="size-3.5" />
                          </button>
                          <a
                            href={getDocumentDownloadUrl(doc.id, kbId)}
                            title="下载源文件"
                            className="text-muted-foreground hover:text-emerald-400 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Download className="size-3.5" />
                          </a>
                        </>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={doc.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{doc.chunk_count ?? 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(doc.size)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatTime(doc.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DeleteDocumentsDialog
                      selectedDocIds={[doc.id]}
                      kbId={kbId}
                      onDocumentsDeleted={async () => {
                        setSelectedIds(new Set())
                        refresh()
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {total > 0 && (
        <PaginationControls
          currentPage={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalCount={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
          isLoading={loading}
        />
      )}

      <DocxPreviewModal
        open={!!previewDoc}
        docId={previewDoc?.id || ''}
        fileName={previewDoc?.name || ''}
        workspace={kbId}
        onClose={() => setPreviewDoc(null)}
      />

    </div>
  )
}

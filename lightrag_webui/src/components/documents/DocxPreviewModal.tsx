import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2, Download, Table } from 'lucide-react'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { getDocumentFileUrl, getDocumentDownloadUrl } from '@/api/lightrag'
import Button from '@/components/ui/Button'

interface DocxPreviewModalProps {
  open: boolean
  docId: string
  fileName: string
  workspace?: string
  onClose: () => void
}

export default function DocxPreviewModal({
  open,
  docId,
  fileName,
  workspace,
  onClose
}: DocxPreviewModalProps) {
  type RenderMode = 'html' | 'pdf' | 'excel' | 'image'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

  const { t } = useTranslation()
  const [html, setHtml] = useState('')
  const [pdfUrl, setPdfUrl] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [excelSheets, setExcelSheets] = useState<{ name: string; html: string }[]>([])
  const [activeSheet, setActiveSheet] = useState(0)
  const [renderMode, setRenderMode] = useState<RenderMode>('html')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fileExt = useMemo(() => fileName.slice(fileName.lastIndexOf('.')).toLowerCase(), [fileName])

  useEffect(() => {
    if (!open || !docId) return

    const fetchAndRender = async () => {
      setLoading(true)
      setError('')
      setHtml('')
      setPdfUrl('')
      setImageUrl('')
      setExcelSheets([])
      setActiveSheet(0)
      try {
        const url = getDocumentFileUrl(docId, workspace)
        const token = localStorage.getItem('LIGHTRAG-API-TOKEN')
        const headers: Record<string, string> = {}
        if (token) headers['Authorization'] = `Bearer ${token}`

        const resp = await fetch(url, { headers })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

        const blob = await resp.blob()
        const arrayBuffer = await blob.arrayBuffer()

        if (fileExt === '.docx' || fileExt === '.doc') {
          setRenderMode('html')
          const result = await mammoth.convertToHtml({ arrayBuffer })
          setHtml(result.value)
        } else if (fileExt === '.ppt' || fileExt === '.pptx') {
          // PowerPoint — no reliable client-side renderer; trigger download
          setError('PowerPoint 文件暂不支持在线预览，请点击右上角下载按钮查看')
          setLoading(false)
          return
        } else if (fileExt === '.txt' || fileExt === '.md' || fileExt === '.csv') {
          setRenderMode('html')
          const text = await blob.text()
          setHtml(`<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;line-height:1.6">${escapeHtml(text)}</pre>`)
        } else if (fileExt === '.xlsx' || fileExt === '.xls') {
          setRenderMode('excel')
          const wb = XLSX.read(arrayBuffer, { type: 'array' })
          const sheets = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name]
            const sheetHtml = XLSX.utils.sheet_to_html(ws, { id: '', editable: false })
            return { name, html: sheetHtml }
          })
          setExcelSheets(sheets)
        } else if (IMAGE_EXTS.has(fileExt)) {
          setRenderMode('image')
          setImageUrl(URL.createObjectURL(blob))
        } else if (fileExt === '.pdf') {
          setRenderMode('pdf')
          setPdfUrl(URL.createObjectURL(blob))
        } else if (fileExt === '.json') {
          setRenderMode('html')
          const text = await blob.text()
          try {
            const parsed = JSON.parse(text)
            setHtml(`<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;line-height:1.6">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`)
          } catch {
            setHtml(`<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;line-height:1.6">${escapeHtml(text)}</pre>`)
          }
        } else if (fileExt === '.xml' || fileExt === '.html' || fileExt === '.htm') {
          setRenderMode('html')
          const text = await blob.text()
          setHtml(`<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;line-height:1.6">${escapeHtml(text)}</pre>`)
        } else {
          window.open(url, '_blank', 'noopener')
          onClose()
          return
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load document')
      } finally {
        setLoading(false)
      }
    }

    fetchAndRender()
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [open, docId, fileName, workspace, onClose, fileExt])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background relative flex max-h-[90vh] w-[90vw] max-w-[1000px] flex-col rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="truncate text-lg font-semibold">{fileName}</h3>
          <div className="flex items-center gap-2">
            <a
              href={getDocumentDownloadUrl(docId, workspace)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-foreground/10 hover:text-emerald-400"
              title="下载源文件"
            >
              <Download className="size-4" />
              {t('common.download', '下载')}
            </a>
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="text-primary size-8 animate-spin" />
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
              {error}
            </div>
          )}
          {renderMode === 'pdf' && pdfUrl && (
            <iframe src={pdfUrl} className="h-full min-h-[70vh] w-full rounded border" title={fileName} />
          )}
          {renderMode === 'image' && imageUrl && (
            <div className="flex items-center justify-center">
              <img src={imageUrl} alt={fileName} className="max-h-[75vh] max-w-full rounded object-contain" />
            </div>
          )}
          {renderMode === 'excel' && excelSheets.length > 0 && (
            <div className="space-y-3">
              {excelSheets.length > 1 && (
                <div className="flex items-center gap-1 overflow-x-auto pb-2">
                  {excelSheets.map((sheet, i) => (
                    <button
                      key={sheet.name}
                      onClick={() => setActiveSheet(i)}
                      className={`shrink-0 rounded px-3 py-1 text-xs font-medium transition-colors ${
                        i === activeSheet
                          ? 'bg-primary/20 text-primary'
                          : 'bg-muted/30 text-muted-foreground hover:bg-foreground/10'
                      }`}
                    >
                      <Table className="mr-1 inline size-3" />
                      {sheet.name}
                    </button>
                  ))}
                </div>
              )}
              <div
                className="overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-sm [&_th]:border [&_th]:bg-muted/30 [&_th]:px-2 [&_th]:py-1 [&_th]:text-sm [&_th]:font-medium"
                dangerouslySetInnerHTML={{ __html: excelSheets[activeSheet]?.html || '' }}
              />
            </div>
          )}
          {renderMode === 'html' && html && (
            <div
              className="prose prose-sm dark:prose-invert max-w-none [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

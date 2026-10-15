import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  archiveCategories, cancelArchiveImport, pauseArchiveImport, resumeArchiveImport, startArchiveImport, useArchiveImports,
} from '@/lib/archive-import'
import type { ArchiveImportState } from '@/lib/engine'
import { createToast } from '@/lib/notifications'

const toast = createToast('imports')
const fail = (e: unknown) => toast.error(String((e as Error).message ?? e))

/** `choose(state)` opens the picker and resolves with the picked category
 *  ids, or null when the user backs out. Render `dialog` somewhere. */
export function useArchiveChooser() {
  const [pending, setPending] = useState<{ state: ArchiveImportState; resolve: (ids: string[] | null) => void } | null>(null)
  const choose = (state: ArchiveImportState) => new Promise<string[] | null>((resolve) => setPending({ state, resolve }))
  const dialog = pending
    ? <ArchiveChoiceDialog key={pending.state.id} state={pending.state} onDone={(ids) => { pending.resolve(ids); setPending(null) }} />
    : null
  return { choose, dialog }
}

function ArchiveChoiceDialog({ state, onDone }: { state: ArchiveImportState; onDone: (ids: string[] | null) => void }) {
  const categories = archiveCategories(state)
  const [picked, setPicked] = useState(() => categories.filter((c) => !c.off).map((c) => c.id))
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(null) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">Import {state.name}</DialogTitle>
        </DialogHeader>
        {categories.length ? (
          <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
            {categories.map((c) => (
              <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent">
                <Checkbox checked={picked.includes(c.id)} onCheckedChange={() => toggle(c.id)} aria-label={c.label} />
                <span className="flex-1 text-sm">{c.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{c.files ? `${c.files.toLocaleString()} files` : 'In settings.json'}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No characters, chats or other collections found. Settings files in it still import.</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onDone(null)}>Cancel</Button>
          <Button onClick={() => onDone(picked)}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`

function statusLine(s: ArchiveImportState): string {
  const done = (s.processed ?? 0).toLocaleString()
  const total = (s.selected ?? s.files).toLocaleString()
  if (s.status === 'uploading') return `Upload paused at ${mb(s.uploaded)} of ${mb(s.size)}. Choose the same file to continue.`
  if (s.status === 'indexing') return `Reading the archive: ${s.files.toLocaleString()} files`
  if (s.status === 'failed') return s.error ?? 'The archive could not be read'
  if (s.status === 'done') return 'Finished'
  if (s.running) return `Importing ${done} / ${total} files`
  if (s.processed === undefined) return 'Uploaded, nothing imported yet'
  return `Paused at ${done} / ${total} files${s.runError ? `: ${s.runError}` : ''}`
}

/** Imports the engine holds for this app: progress, pause, resume, cancel.
 *  The engine runs them, so they keep going while this page is closed. */
export function ArchiveImportPanel({ choose }: { choose: (state: ArchiveImportState) => Promise<string[] | null> }) {
  const imports = useArchiveImports()
  if (!imports.length) return null
  const pick = async (s: ArchiveImportState) => {
    const picked = await choose(s)
    if (picked) await startArchiveImport(s, picked)
  }
  return (
    <div className="flex flex-col gap-2">
      {imports.map((s) => {
        const ratio = s.status === 'uploading' ? s.uploaded / s.size : (s.processed ?? 0) / Math.max(1, s.selected ?? s.files)
        return (
          <div key={s.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="text-xs text-muted-foreground">{statusLine(s)}</p>
              </div>
              {s.status === 'ready' && s.running && (
                <Button variant="outline" size="sm" onClick={() => void pauseArchiveImport(s.id).catch(fail)}>Pause</Button>
              )}
              {s.status === 'ready' && !s.running && s.processed !== undefined && (
                <Button variant="outline" size="sm" onClick={() => void resumeArchiveImport(s.id).catch(fail)}>Resume</Button>
              )}
              {s.status === 'ready' && !s.running && s.processed === undefined && (
                <Button variant="outline" size="sm" onClick={() => void pick(s).catch(fail)}>Import</Button>
              )}
              {s.status !== 'done' && s.status !== 'indexing' && (
                <Button variant="ghost" size="sm" onClick={() => void cancelArchiveImport(s.id).catch(fail)}>Cancel</Button>
              )}
            </div>
            {s.status !== 'failed' && (
              <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

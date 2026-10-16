import { useSyncExternalStore } from 'react'
import { createToast } from '@/lib/notifications'
import { downloadTextFile } from './export'
import {
  archiveImportState, importArchiveBatches, listArchiveImports, removeArchiveImport,
  runArchiveImport, stopArchiveImport, uploadArchive, type ArchiveImportState, type ArchiveSummary,
} from './engine'
import { holdLiveHydrate, useApp } from './store'

const toast = createToast('imports')

/** What an archive can hold, as the user picks it. `settingsFile` marks
 *  data a foreign settings.json may carry even with no folder of its own;
 *  `off` starts unticked. */
export const ARCHIVE_CATEGORIES: { id: string; label: string; collections: string[]; settingsFile?: boolean; off?: boolean }[] = [
  { id: 'characters', label: 'Characters', collections: ['characters/'] },
  { id: 'lorebooks', label: 'Lorebooks', collections: ['worlds/', 'lorebooks/'] },
  { id: 'presets', label: 'Presets', collections: ['presets/', 'openai settings/', 'textgen settings/'] },
  { id: 'templates', label: 'Instruct templates', collections: ['instruct/'], off: true },
  { id: 'regex', label: 'Regex scripts', collections: ['extensions/regex/', 'regex/'], settingsFile: true },
  { id: 'personas', label: 'Personas', collections: ['personas/', 'personas.json', 'User Avatars/'], settingsFile: true },
  { id: 'groups', label: 'Groups', collections: ['groups/'] },
  { id: 'chats', label: 'Chats', collections: ['chats/'] },
  { id: 'groupChats', label: 'Group chats', collections: ['group chats/'] },
  { id: 'quickReplies', label: 'Quick replies', collections: ['QuickReplies/'] },
  { id: 'themes', label: 'Themes', collections: ['themes/'] },
  { id: 'databank', label: 'Data bank', collections: ['databank/'] },
]
/** Small files that hold settings and links, read whatever was picked. */
const ALWAYS = ['User Settings/', 'settings.json', 'library.json', 'variables.json']

/** Categories present in an archive, with the number of files each has. */
export function archiveCategories(state: ArchiveImportState) {
  const counts = state.collectionCounts ?? {}
  const settings = (counts['settings.json'] ?? 0) > 0
  return ARCHIVE_CATEGORIES
    .map((c) => ({ ...c, files: c.collections.reduce((n, name) => n + (counts[name] ?? 0), 0) }))
    .filter((c) => c.files > 0 || (c.settingsFile && settings))
}

export const includeFor = (state: ArchiveImportState, picked: string[]) =>
  [...ALWAYS, ...ARCHIVE_CATEGORIES.filter((c) => picked.includes(c.id)).flatMap((c) => c.collections)]
    .filter((name) => state.collections.includes(name))

const LABELS: Record<string, string> = { regex: 'regex scripts', quickReplies: 'quick reply sets', databank: 'data bank files' }
export function describeCounts(counts: Record<string, number> | undefined): string {
  const parts = Object.entries(counts ?? {}).filter(([key, n]) => key !== 'errors' && n > 0).map(([key, n]) => `${n.toLocaleString()} ${LABELS[key] ?? key}`)
  return parts.length ? `Imported ${parts.join(', ')}` : 'Nothing recognized in that archive'
}

// ── imports the engine is running, shared by every view ──
let imports: ArchiveImportState[] = []
const listeners = new Set<() => void>()
const publish = (next: ArchiveImportState[]) => {
  imports = next
  holdLiveHydrate(next.some((i) => i.running))
  for (const l of listeners) l()
}
const upsert = (state: ArchiveImportState) => publish([state, ...imports.filter((i) => i.id !== state.id)])
const drop = (id: string) => publish(imports.filter((i) => i.id !== id))

export const useArchiveImports = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => imports)

const following = new Map<string, Promise<ArchiveSummary | null>>()
const cancelled = new Set<string>()

function finished(counts: Record<string, number> | undefined, errors: string[] = []): ArchiveSummary {
  const skipped = counts?.errors ?? errors.length
  toast.success(describeCounts(counts))
  if (skipped) toast.warning(`${skipped} files skipped`, {
    description: errors.slice(0, 3).join('\n'),
    action: { label: 'Download report', onClick: () => downloadTextFile('import-errors.txt', `${skipped} failures. Showing ${errors.length}.\n\n${errors.join('\n')}`) },
  })
  return { characters: [], groups: [], lorebooks: [], presets: [], regex: [], personas: [], themes: [], chats: [], databank: [], errors, counts }
}

/** Shows a running import until it ends. Resolves with the result, or null
 *  when it was paused, cancelled or stopped with an error. */
export function followArchiveImport(id: string): Promise<ArchiveSummary | null> {
  const known = following.get(id)
  if (known) return known
  const toastId = `archive:${id}`
  const run = (async () => {
    try {
      for (;;) {
        if (cancelled.has(id)) return null
        const state = await archiveImportState(id)
        if (cancelled.has(id)) return null
        upsert(state)
        if (state.status === 'done') {
          toast.dismiss(toastId)
          await removeArchiveImport(id).catch(() => undefined)
          drop(id)
          await useApp.getState().hydrate()
          return finished(state.counts, state.errors)
        }
        if (!state.running) {
          toast.dismiss(toastId)
          if (state.runError) toast.error('Import stopped', { description: state.runError })
          return null
        }
        toast.loading('Importing', {
          id: toastId,
          description: `${(state.processed ?? 0).toLocaleString()} / ${(state.selected ?? state.files).toLocaleString()} files`,
          action: { label: 'Pause', onClick: () => void pauseArchiveImport(id).catch((e) => toast.error(String((e as Error).message ?? e))) },
        })
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } catch (error) {
      toast.dismiss(toastId)
      // no longer followed, so nothing would release the held live updates
      holdLiveHydrate(false)
      if (cancelled.has(id)) return null
      throw error
    } finally { following.delete(id) }
  })()
  following.set(id, run)
  return run
}

export async function pauseArchiveImport(id: string) {
  upsert(await stopArchiveImport(id))
}

export async function resumeArchiveImport(id: string) {
  const state = await runArchiveImport(id)
  if (state) { upsert(state); return followArchiveImport(id) }
  return null
}

/** Starts an uploaded import over the picked categories (all of them when
 *  `picked` is undefined). null: this engine cannot run imports itself. */
export async function startArchiveImport(state: ArchiveImportState, picked?: string[]) {
  const started = await runArchiveImport(state.id, picked ? includeFor(state, picked) : undefined)
  if (!started) return null
  upsert(started)
  return followArchiveImport(state.id)
}

/** Stops an import and drops its upload; what it already imported stays. */
export async function cancelArchiveImport(id: string) {
  cancelled.add(id)
  toast.dismiss(`archive:${id}`)
  try { await removeArchiveImport(id) } catch (error) { cancelled.delete(id); throw error }
  drop(id)
}

/** Whether this engine runs imports itself: only one that does can leave
 *  unpicked categories unread, so an older engine gets no picker. */
let engineRuns: Promise<boolean> | null = null
const engineRunsImports = () => (engineRuns ??= listArchiveImports().then(() => true, () => false))

/** Loads the imports the engine holds and follows any still running, so a
 *  reload or a view change keeps showing their progress. */
export async function loadArchiveImports() {
  try {
    const list = await listArchiveImports()
    publish(list)
    for (const state of list) if (state.running || state.status === 'done') void followArchiveImport(state.id).catch(() => undefined)
  } catch { /* engine without staged imports */ }
}

/** Upload, then (when `choose` is given) let the user pick what to import,
 *  then let the engine run it. Resolves with the result, or null when the
 *  user cancelled or paused. */
export async function importArchiveWithProgress(file: File, choose?: (state: ArchiveImportState) => Promise<string[] | null>): Promise<ArchiveSummary | null> {
  const controller = new AbortController()
  const id = `archive:${file.name}:${file.size}`
  let state: ArchiveImportState
  try {
    const upload = await uploadArchive(file, (stage, done, total) => {
      const description = stage === 'Uploading' ? `${(done / 1024 ** 2).toFixed(1)} / ${(total / 1024 ** 2).toFixed(1)} MB` : `${done.toLocaleString()} files`
      toast.loading(stage, { id, description, action: { label: 'Pause', onClick: () => controller.abort() } })
    }, controller.signal)
    if ('summary' in upload) {
      await useApp.getState().hydrate()
      const { summary } = upload
      return finished(summary.counts ?? Object.fromEntries(Object.entries(summary).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])), summary.errors)
    }
    state = upload.state
  } catch (error) {
    if (controller.signal.aborted) { toast.info('Upload paused', { description: 'Choose the same file to continue.' }); return null }
    throw error
  } finally { toast.dismiss(id) }
  upsert(state)
  if (state.running || state.processed !== undefined) return state.running ? followArchiveImport(state.id) : resumeArchiveImport(state.id)
  const picked = choose && await engineRunsImports() ? await choose(state) : undefined
  if (picked === null) { await cancelArchiveImport(state.id); return null }
  const started = await runArchiveImport(state.id, picked ? includeFor(state, picked) : undefined)
  if (started) { upsert(started); return followArchiveImport(state.id) }
  // an engine that cannot run imports: drive the batches from this page
  try {
    const summary = await importArchiveBatches(state, (stage, done, total) => {
      toast.loading(stage, { id, description: `${done.toLocaleString()} / ${total.toLocaleString()} files`, action: { label: 'Pause', onClick: () => controller.abort() } })
    }, controller.signal)
    drop(state.id)
    await useApp.getState().hydrate()
    return finished(summary.counts, summary.errors)
  } catch (error) {
    if (controller.signal.aborted) { toast.info('Import paused', { description: 'Choose the same file to continue.' }); return null }
    throw error
  } finally { toast.dismiss(id) }
}

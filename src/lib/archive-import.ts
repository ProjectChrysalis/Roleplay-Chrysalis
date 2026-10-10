import { createToast } from '@/lib/notifications'
import { downloadTextFile } from './export'
import { importArchive, type ArchiveSummary } from './engine'

const toast = createToast('imports')

export async function importArchiveWithProgress(file: File): Promise<ArchiveSummary> {
  const controller = new AbortController()
  const id = `archive:${file.name}:${file.size}`
  try {
    const result = await importArchive(file, (stage, done, total) => {
      const description = stage === 'Uploading' ? `${(done / 1024 ** 2).toFixed(1)} / ${(total / 1024 ** 2).toFixed(1)} MB` : total ? `${done} / ${total} files` : `${done} files`
      toast.loading(stage, { id, description, action: { label: 'Pause', onClick: () => controller.abort() } })
    }, controller.signal)
    const skipped = result.counts?.errors ?? result.errors.length;
    if (skipped) toast.warning(`${skipped} files skipped`, {
      description: result.errors.slice(0, 3).join('\n'),
      action: { label: 'Download report', onClick: () => downloadTextFile('import-errors.txt', `${skipped} failures. Showing ${result.errors.length}.\n\n${result.errors.join('\n')}`) },
    });
    return result
  } catch (error) {
    if (controller.signal.aborted) toast.info('Import paused', { description: 'Select the same file to resume.' })
    throw error
  } finally { toast.dismiss(id) }
}

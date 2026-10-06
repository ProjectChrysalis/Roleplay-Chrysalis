// ── Import/export interop: browser downloads, plus re-exports of the pure
// portable-shape converters (card PNG reading included) ──
export { presetExport, presetImport, regexImport, regexExport, extractCharaFromPng } from './import-shapes.js'
import { saveFile } from './export'
import { portableMedia } from './media-export'

// ─── Download helper ───
export async function downloadJson(data: unknown, filename: string) {
  saveFile(new Blob([JSON.stringify(await portableMedia(data), null, 2)], { type: 'application/json' }), filename.endsWith('.json') ? filename : `${filename}.json`)
}

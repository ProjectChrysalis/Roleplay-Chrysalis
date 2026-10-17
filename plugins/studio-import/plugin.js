/**
 * Studio Import — clean-room data import against public file formats.
 * Parsed files use /import/batch. Archives use /import/zip with bounded
 * entry batches supplied by the engine's file-backed upload service.
 */

export { handleRoute } from "./src/import.js";

export const TOOLS = [];

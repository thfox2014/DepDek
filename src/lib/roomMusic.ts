import type * as api from "../api";
export type MusicServices = Pick<typeof api, "fileIndexQuery" | "vaultReadBinary"> & Partial<Pick<typeof api, "fileLibraryImport">>;
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const extensions = ["mp3", "wav", "ogg", "flac"];
export const isMusicFile = (path: string) => extensions.includes(path.split(".").pop()?.toLowerCase() ?? "");
export async function queryMusic(service: MusicServices, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const items: api.FileIndexRecord[] = []; let partial = false, libraryId = "";
  const accept = (response: api.FileIndexResult) => {
    const identity = response.summary.library_id;
    if (!identity || libraryId && libraryId !== identity) throw new Error("Home changed");
    libraryId = identity;
    for (const file of response.items) if (isMusicFile(file.path) && !items.some((item) => item.path === file.path)) items.push(file);
  };
  if (!needle) {
    // Query existing index only; never recurse through Home or read media bytes.
    for (const extension of extensions) {
      const result = await service.fileIndexQuery({ category: "other", query: `.${extension}`, limit: 100 });
      accept(result); partial ||= result.total > result.items.length;
    }
  } else {
    for (let page = 0; page < 5; page++) {
      const result = await service.fileIndexQuery({ category: "other", query: needle, offset: page * 100, limit: 100 });
      accept(result);
      if ((page + 1) * 100 >= result.total) break;
      if (page === 4) partial = true;
    }
  }
  partial ||= items.length > 100;
  return { items: items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).slice(0, 100), partial, libraryId };
}
export function checkedAudio(result: api.ReadBinaryResult, file: api.FileIndexRecord): Blob {
  const types = ["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac"];
  if (result.sha256.toLowerCase() !== file.sha256.toLowerCase() || result.size !== file.size || result.size > MAX_AUDIO_BYTES
      || result.data_base64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || !types.includes(result.mime)) throw new Error("changed audio");
  const raw = atob(result.data_base64);
  if (raw.length !== result.size) throw new Error("changed audio");
  return new Blob([Uint8Array.from(raw, (char) => char.charCodeAt(0))], { type: result.mime });
}

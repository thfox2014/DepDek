// Isolated preview: in-memory notes and one-second synthetic audio, no native APIs.
import type * as api from "../../src/api";
import type { FamilyServices } from "../../src/components/FamilyPanel";
import type { MusicServices } from "../../src/lib/roomMusic";
export function workspaceExamples(): { family: FamilyServices; music: MusicServices } {
  const libraryId = "4".repeat(64), notes: api.FamilySceneNote[] = [];
  const sampleRate = 8000, buffer = new ArrayBuffer(44 + sampleRate * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, sampleRate * 2, true);
  for (let i = 0; i < sampleRate; i++) view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 220 * i / sampleRate) * 2000 * Math.min(1, i / 400, (sampleRate - i) / 400), true);
  const bytes = new Uint8Array(buffer), data = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  const sha = crypto.subtle.digest("SHA-256", buffer).then((value) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  const files = async (): Promise<api.FileIndexRecord[]> => { const hash = await sha; return ["午后-合成示例.wav", "晚安-合成示例.wav"].map((name) => ({ name, path: `music/${name}`, original_path: `/demo/music/${name}`, sha256: hash, category: "other", detected_by: "fallback", size: bytes.length, modified_ms: 1792861200000, indexed_at_ms: 1792861200000 })); };
  return {
    family: {
      familyInfoState: async () => ({ library_id: libraryId, notes: structuredClone(notes) }),
      familyInfoPut: async (input) => {
        if (input.libraryId !== libraryId) throw new Error("Home changed");
        const index = notes.findIndex((note) => note.scene === input.scene), old = notes[index];
        if ((old?.revision ?? 0) !== input.expectedRevision) throw new Error("revision conflict");
        const note = { scene: input.scene, note: input.note.trim(), revision: input.expectedRevision + 1, updated_at_ms: Date.now() };
        if (index >= 0) notes[index] = note; else notes.push(note);
        return structuredClone(note);
      },
    },
    music: {
      fileIndexQuery: async (filter = {}) => {
        const items = (await files()).filter((file) => !filter.query || file.path.toLocaleLowerCase().includes(filter.query.toLocaleLowerCase()));
        return { items: items.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100)), total: items.length, summary: { library_id: libraryId, indexed_at_ms: 1792861200000, total: 2, total_bytes: bytes.length * 2, skipped: 0, categories: { photos: 0, documents: 0, videos: 0, mail: 0, other: 2 } } };
      },
      vaultReadBinary: async (path) => { if (!(await files()).some((file) => file.path === path)) throw new Error("not indexed"); return { data_base64: data, size: bytes.length, sha256: await sha, mime: "audio/wav" }; },
    },
  };
}

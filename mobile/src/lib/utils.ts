import type { Category, Profile, Resource } from "./types.ts";

export function categoryOf(name: string): Exclude<Category, "全部"> {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (
    [
      "jpg",
      "jpeg",
      "png",
      "webp",
      "heic",
      "heif",
      "gif",
      "avif",
      "tif",
      "tiff",
      "bmp",
    ].includes(ext)
  )
    return "照片";
  if (["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"].includes(ext))
    return "视频";
  if (["eml", "msg", "mbox"].includes(ext)) return "邮件";
  if (
    [
      "pdf",
      "txt",
      "md",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "csv",
      "json",
      "rtf",
      "odt",
    ].includes(ext)
  )
    return "文档";
  return "其他";
}
export function filterResources(
  resources: Resource[],
  category: Category,
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return resources.filter(
    (item) =>
      (category === "全部" ||
        (item.category === category && item.kind !== "dir")) &&
      `${item.name} ${item.path} ${item.sha256 || ""}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}
export function formatSize(bytes: number | null) {
  if (bytes === null) return "大小待读取";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function validProfile(profile: Profile | null): profile is Profile {
  return Boolean(
    profile &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(profile.id) &&
      Number.isSafeInteger(profile.revision) &&
      profile.revision > 0 &&
      ["pi", "deepseek-harness"].includes(profile.engine),
  );
}
export function withinPromptLimit(text: string) {
  return (
    Boolean(text.trim()) && new TextEncoder().encode(text).byteLength <= 16384
  );
}
export function joinResourcePath(parent: string, name: string) {
  if (!parent || !name || [".", ".."].includes(name) || /[\\/\0]/.test(name))
    throw new Error("INVALID_INPUT");
  return `${parent.replace(/\/$/, "")}/${name}`;
}
export const supportsTextPreview = (name: string) =>
  /\.(txt|md|csv|json|eml)$/i.test(name);

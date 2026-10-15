/**
 * mcp.md grant lines.
 *
 * A line is a grant only when it is exactly `connector/tool`. Headings,
 * prose and unknown lines stay documentation and never become tools.
 * The one-shot analysis prompt still treats the file as text, not as a
 * tool registration.
 */

const GRANT_LINE = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/;
export const MAX_GRANTS = 64;

export function isGrant(value: string): boolean {
  return GRANT_LINE.test(value);
}

export function parseGrantDocument(markdown: string): string[] {
  const seen = new Set<string>();
  const grants: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^[-*]\s+/, "");
    if (!candidate || candidate.startsWith("#")) continue;
    const match = GRANT_LINE.exec(candidate);
    if (!match) continue;
    const grant = `${match[1]}/${match[2]}`;
    if (seen.has(grant)) continue;
    seen.add(grant);
    grants.push(grant);
    if (grants.length >= MAX_GRANTS) break;
  }
  return grants;
}

export function sanitizeGrantList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return parseGrantDocument(values.filter((value) => typeof value === "string").join("\n"));
}

/** When both the file and the session argument exist, the file wins ties by intersection. */
export function effectiveGrants(fileGrants: string[] | null, explicit: string[] | null): string[] {
  if (fileGrants && explicit) {
    const allowed = new Set(fileGrants);
    return explicit.filter((grant) => allowed.has(grant));
  }
  return fileGrants ?? explicit ?? [];
}

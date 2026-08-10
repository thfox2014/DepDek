/** Calendar hub adapters (contract section 8).
 *
 * The local calendar/events.json file is the user's canonical view. Remote
 * calendars are imported through an ICS/CalDAV endpoint and never overwrite
 * local-only events. Outbound writes are explicit and currently use CalDAV's
 * PUT semantics; Google/Microsoft/Apple accounts can be connected with a
 * subscription endpoint for read sync and are marked read-only until OAuth is
 * configured.
 */

import { RpcError } from "./rpc.js";
import type { VaultClient } from "./tools.js";

export const CALENDAR_CONFIG_PATH = "calendar/accounts.json";
export const CALENDAR_EVENTS_PATH = "calendar/events.json";
export const CALENDAR_SESSION_ID = "calendar";

export type CalendarProvider = "google" | "microsoft" | "apple" | "caldav" | "ics";

export interface CalendarAccount {
  id: string;
  name: string;
  provider: CalendarProvider;
  endpoint?: string;
  write_endpoint?: string;
  calendar_id?: string;
  user?: string;
  password?: string;
  access_token?: string;
  enabled?: boolean;
  readonly?: boolean;
}

export interface CalendarEvent {
  id: string;
  remote_id?: string;
  source_account_id?: string;
  source_name?: string;
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  updated_at?: string;
}

export interface CalendarAccountsFile { accounts: CalendarAccount[] }
export interface CalendarEventsFile { version: 1; updated_at: string; events: CalendarEvent[] }
export interface CalendarSyncAccountResult { id: string; name: string; imported: number; error?: string }
export interface CalendarSyncResult { imported: number; accounts: CalendarSyncAccountResult[] }
export interface CalendarPushResult { account: string; event_id: string; remote_id: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Apple publishes shared calendars as `webcal://` links. Node's fetch only
 * accepts HTTP(S), while webcal is the same read-only ICS feed over HTTPS. */
export function normalizeCalendarEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (/^webcal:\/\//i.test(value)) return `https://${value.slice("webcal://".length)}`;
  return value;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return `${error.message}（${cause.message}）`;
  return error.message;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function unfoldIcs(source: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  return unfolded;
}

function parseIcsDate(raw: string, allDay: boolean): string {
  if (allDay && /^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
  }
  const [, year, month, day, hour, minute, second, utc] = match;
  const parsed = utc
    ? new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
    : new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return parsed.toISOString();
}

/** Parse the interoperable VEVENT subset used by mainstream ICS feeds. */
export function parseIcsEvents(source: string, account: CalendarAccount): CalendarEvent[] {
  const lines = unfoldIcs(source);
  const events: CalendarEvent[] = [];
  let current: Record<string, { value: string; params: string }> | null = null;
  const flush = () => {
    if (!current) return;
    const uid = current.UID?.value || `${account.id}-${events.length + 1}`;
    const start = current.DTSTART;
    const end = current.DTEND ?? start;
    if (!start || !end) { current = null; return; }
    const allDay = /VALUE=DATE/i.test(start.params) || /^\d{8}$/.test(start.value);
    events.push({
      id: `${account.id}:${uid}`,
      remote_id: uid,
      source_account_id: account.id,
      source_name: account.name,
      title: unescapeIcs(current.SUMMARY?.value || "(无主题)"),
      start: parseIcsDate(start.value, allDay),
      end: parseIcsDate(end.value, allDay),
      all_day: allDay,
      location: unescapeIcs(current.LOCATION?.value || ""),
      description: unescapeIcs(current.DESCRIPTION?.value || ""),
      updated_at: new Date().toISOString(),
    });
    current = null;
  };

  for (const line of lines) {
    if (line.toUpperCase() === "BEGIN:VEVENT") { flush(); current = {}; continue; }
    if (line.toUpperCase() === "END:VEVENT") { flush(); continue; }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const rawKey = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const [key, ...params] = rawKey.split(";");
    if (!key) continue;
    current[key.toUpperCase()] = { value, params: params.join(";") };
  }
  flush();
  return events;
}

async function readJson<T>(vault: VaultClient, path: string, fallback: T): Promise<T> {
  try {
    const result = await vault.request<{ content: string }>("vault/read_file", { session_id: CALENDAR_SESSION_ID, path });
    return JSON.parse(result.content) as T;
  } catch (error) {
    if (error instanceof RpcError && error.code === -32002) return fallback;
    throw error;
  }
}

function authHeaders(account: CalendarAccount): Record<string, string> {
  if (account.access_token) return { Authorization: `Bearer ${account.access_token}` };
  if (account.user && account.password) {
    const encoded = Buffer.from(`${account.user}:${account.password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlElementText(source: string, localName: string): string | undefined {
  const expression = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\s*>`, "i");
  const match = expression.exec(source);
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
}

function xmlResponseBlocks(source: string): string[] {
  const expression = /<(?:[A-Za-z_][\w.-]*:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response\s*>/gi;
  return [...source.matchAll(expression)].map((match) => match[1] ?? "");
}

function resolveCalDavHref(base: string, href: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

async function calDavRequest(account: CalendarAccount, url: string, method: "PROPFIND" | "REPORT", body: string, depth: "0" | "1", fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url, {
    method,
    headers: { Depth: depth, "Content-Type": "text/xml", Accept: "application/xml, text/xml", ...authHeaders(account) },
    body,
  });
  if (!response.ok) throw new Error(`CalDAV ${method} ${url} 返回 HTTP ${response.status}`);
  return response.text();
}

const PRINCIPAL_PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const HOME_PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const COLLECTION_PROPFIND = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>';
const EVENT_REPORT = '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';

function isCalDavAppleEndpoint(account: CalendarAccount): boolean {
  return account.provider === "apple" && /caldav\.icloud\.com/i.test(account.endpoint ?? "");
}

async function syncAppleCalDav(account: CalendarAccount, fetchImpl: FetchLike): Promise<CalendarEvent[]> {
  const endpoint = account.endpoint ? normalizeCalendarEndpoint(account.endpoint) : "https://caldav.icloud.com/";
  const principalXml = await calDavRequest(account, endpoint, "PROPFIND", PRINCIPAL_PROPFIND, "0", fetchImpl);
  const principalProperty = xmlElementText(principalXml, "current-user-principal");
  const principalHref = (principalProperty ? xmlElementText(principalProperty, "href") : undefined) ?? xmlElementText(principalXml, "href");
  if (!principalHref) throw new Error("iCloud CalDAV 未返回 current-user-principal；请检查 Apple ID 和应用专用密码");

  const principalUrl = resolveCalDavHref(endpoint, principalHref);
  const homeXml = await calDavRequest(account, principalUrl, "PROPFIND", HOME_PROPFIND, "0", fetchImpl);
  const homeProperty = xmlElementText(homeXml, "calendar-home-set");
  const homeHref = (homeProperty ? xmlElementText(homeProperty, "href") : undefined) ?? xmlElementText(homeXml, "href");
  if (!homeHref) throw new Error("iCloud CalDAV 未返回 calendar-home-set");
  const homeUrl = resolveCalDavHref(principalUrl, homeHref);

  const collectionsXml = await calDavRequest(account, homeUrl, "PROPFIND", COLLECTION_PROPFIND, "1", fetchImpl);
  const collections = xmlResponseBlocks(collectionsXml).flatMap((block) => {
    const href = xmlElementText(block, "href");
    const resourceType = xmlElementText(block, "resourcetype") ?? block;
    if (!href || !/(?:^|[<\s])(?:[A-Za-z_][\w.-]*:)?calendar(?:\s|\/?>)/i.test(resourceType)) return [];
    return [{ href: resolveCalDavHref(homeUrl, href), name: xmlElementText(block, "displayname") || account.name }];
  });
  if (!collections.length) throw new Error("iCloud CalDAV 未发现可访问的日历集合");

  const events: CalendarEvent[] = [];
  for (const collection of collections) {
    const reportXml = await calDavRequest(account, collection.href, "REPORT", EVENT_REPORT, "1", fetchImpl);
    for (const block of xmlResponseBlocks(reportXml)) {
      const dataMatches = block.matchAll(/<(?:[A-Za-z_][\w.-]*:)?calendar-data(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?calendar-data\s*>/gi);
      for (const match of dataMatches) {
        const ics = decodeXml(match[1] ?? "").trim();
        if (ics) events.push(...parseIcsEvents(ics, { ...account, name: `${account.name} · ${collection.name}` }));
      }
    }
  }
  return events;
}

function isValidAccount(account: CalendarAccount): boolean {
  return Boolean(account.id.trim() && account.name.trim() && account.provider);
}

export async function syncCalendar(
  vault: VaultClient,
  opts: { account?: string } = {},
  fetchImpl: FetchLike = fetch,
): Promise<CalendarSyncResult> {
  const config = await readJson<CalendarAccountsFile>(vault, CALENDAR_CONFIG_PATH, { accounts: [] });
  const accounts = config.accounts.filter((account) => isValidAccount(account) && account.enabled !== false && (!opts.account || account.id === opts.account));
  const existing = await readJson<CalendarEventsFile>(vault, CALENDAR_EVENTS_PATH, { version: 1, updated_at: new Date().toISOString(), events: [] });
  const merged = new Map(existing.events.map((event) => [event.id, event]));
  const results: CalendarSyncAccountResult[] = [];

  for (const account of accounts) {
    if (!account.endpoint) {
      results.push({ id: account.id, name: account.name, imported: 0, error: "未配置日历订阅或 CalDAV 地址" });
      continue;
    }
    try {
      const endpoint = normalizeCalendarEndpoint(account.endpoint);
      const importedEvents = isCalDavAppleEndpoint(account)
        ? await syncAppleCalDav(account, fetchImpl)
        : await (async () => {
          const response = await fetchImpl(endpoint, { headers: { Accept: "text/calendar, text/plain", ...authHeaders(account) } });
          if (!response.ok) throw new Error(`日历服务返回 HTTP ${response.status}`);
          return parseIcsEvents(await response.text(), account);
        })();
      for (const event of importedEvents) merged.set(event.id, event);
      results.push({ id: account.id, name: account.name, imported: importedEvents.length });
    } catch (error) {
      results.push({ id: account.id, name: account.name, imported: 0, error: describeError(error) });
    }
  }

  await vault.request("vault/write_file", {
    session_id: CALENDAR_SESSION_ID,
    path: CALENDAR_EVENTS_PATH,
    content: JSON.stringify({ version: 1, updated_at: new Date().toISOString(), events: [...merged.values()] }, null, 2) + "\n",
  });
  return { imported: results.reduce((total, result) => total + result.imported, 0), accounts: results };
}

function renderIcsEvent(event: CalendarEvent): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const toIcs = (value: string) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const escape = (value = "") => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DepDek//Calendar Hub//EN", "BEGIN:VEVENT", `UID:${escape(event.remote_id || event.id)}`, `DTSTAMP:${stamp}`, `DTSTART:${toIcs(event.start)}`, `DTEND:${toIcs(event.end)}`, `SUMMARY:${escape(event.title)}`, event.location ? `LOCATION:${escape(event.location)}` : "", event.description ? `DESCRIPTION:${escape(event.description)}` : "", "END:VEVENT", "END:VCALENDAR", ""].filter(Boolean).join("\r\n");
}

export async function pushCalendarEvent(
  vault: VaultClient,
  opts: { account: string; event: CalendarEvent },
  fetchImpl: FetchLike = fetch,
): Promise<CalendarPushResult> {
  const config = await readJson<CalendarAccountsFile>(vault, CALENDAR_CONFIG_PATH, { accounts: [] });
  const account = config.accounts.find((item) => item.id === opts.account);
  if (!account) throw new RpcError(-32002, `unknown calendar account: ${opts.account}`);
  if (account.provider !== "caldav") throw new Error("Google、Microsoft 和 Apple 账户需要 OAuth 授权后才能写回；当前可直接写回 CalDAV 日历");
  const endpoint = account.write_endpoint || account.endpoint;
  if (!endpoint) throw new Error("未配置 CalDAV 写入地址");
  const remoteId = opts.event.remote_id || opts.event.id;
  const url = `${endpoint.replace(/\/$/, "")}/${encodeURIComponent(remoteId)}.ics`;
  const response = await fetchImpl(url, { method: "PUT", headers: { "Content-Type": "text/calendar; charset=utf-8", ...authHeaders(account) }, body: renderIcsEvent(opts.event) });
  if (!response.ok) throw new Error(`CalDAV 写回失败：HTTP ${response.status}`);
  return { account: account.name, event_id: opts.event.id, remote_id: remoteId };
}

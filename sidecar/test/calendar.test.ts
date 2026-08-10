import { describe, expect, it, vi } from "vitest";
import { normalizeCalendarEndpoint, parseIcsEvents, pushCalendarEvent, syncCalendar, type CalendarAccount } from "../src/calendar.js";
import { RpcError } from "../src/rpc.js";
import type { VaultClient } from "../src/tools.js";

function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const vault: VaultClient = {
    request: vi.fn(async (method: string, params: any) => {
      if (method === "vault/read_file") {
        const content = files.get(params.path);
        if (content === undefined) throw new RpcError(-32002, "path not found");
        return { content, size: content.length, sha256: "x" };
      }
      if (method === "vault/write_file") {
        files.set(params.path, params.content);
        return { size: params.content.length, sha256: "x" };
      }
      throw new Error(`unexpected method ${method}`);
    }),
  };
  return { vault, files };
}

const ICS = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:meeting-1\r\nDTSTART:20260808T093000Z\r\nDTEND:20260808T103000Z\r\nSUMMARY:产品周会\r\nLOCATION:会议室 B\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:day-1\r\nDTSTART;VALUE=DATE:20260809\r\nDTEND;VALUE=DATE:20260810\r\nSUMMARY:休息日\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

const ACCOUNT: CalendarAccount = { id: "google", name: "Google", provider: "google", endpoint: "https://calendar.test/feed.ics", enabled: true };

describe("calendar adapters", () => {
  it("normalizes Apple's webcal subscription links for Node fetch", () => {
    expect(normalizeCalendarEndpoint("webcal://p99-caldav.icloud.com/published/2/feed")).toBe("https://p99-caldav.icloud.com/published/2/feed");
    expect(normalizeCalendarEndpoint("https://calendar.test/feed.ics")).toBe("https://calendar.test/feed.ics");
  });

  it("parses timed and all-day ICS events", () => {
    const events = parseIcsEvents(ICS, ACCOUNT);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ remote_id: "meeting-1", title: "产品周会", location: "会议室 B", all_day: false });
    expect(events[1]).toMatchObject({ remote_id: "day-1", title: "休息日", all_day: true });
  });

  it("imports remote events into the local canonical file", async () => {
    const { vault, files } = fakeVault({ "calendar/accounts.json": JSON.stringify({ accounts: [ACCOUNT] }), "calendar/events.json": JSON.stringify({ version: 1, updated_at: "", events: [{ id: "local", title: "本地事件", start: "2026-08-08T01:00:00.000Z", end: "2026-08-08T02:00:00.000Z" }] }) });
    const fetchImpl = vi.fn(async () => new Response(ICS, { status: 200, headers: { "content-type": "text/calendar" } }));
    await expect(syncCalendar(vault, {}, fetchImpl)).resolves.toMatchObject({ imported: 2, accounts: [{ id: "google", imported: 2 }] });
    expect(JSON.parse(files.get("calendar/events.json")!).events).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledWith("https://calendar.test/feed.ics", expect.objectContaining({ headers: expect.objectContaining({ Accept: "text/calendar, text/plain" }) }));
  });

  it("fetches an Apple webcal link as HTTPS", async () => {
    const account: CalendarAccount = { id: "apple", name: "appleCal", provider: "apple", endpoint: "webcal://icloud.test/published/feed", enabled: true };
    const { vault } = fakeVault({ "calendar/accounts.json": JSON.stringify({ accounts: [account] }), "calendar/events.json": JSON.stringify({ version: 1, updated_at: "", events: [] }) });
    const fetchImpl = vi.fn(async () => new Response(ICS, { status: 200 }));
    await expect(syncCalendar(vault, { account: "apple" }, fetchImpl)).resolves.toMatchObject({ imported: 2, accounts: [{ id: "apple", imported: 2 }] });
    expect(fetchImpl).toHaveBeenCalledWith("https://icloud.test/published/feed", expect.anything());
  });

  it("discovers iCloud calendars through CalDAV and reports VEVENT data", async () => {
    const account: CalendarAccount = { id: "apple-caldav", name: "appleCal", provider: "apple", endpoint: "https://caldav.icloud.com/", user: "honghuang2001@gmail.com", password: "app-password", enabled: true };
    const principal = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`;
    const home = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`;
    const collections = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:displayname>家庭</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`;
    const report = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/home/event.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[${ICS}]]></c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`;
    const responses = [principal, home, collections, report];
    const { vault, files } = fakeVault({ "calendar/accounts.json": JSON.stringify({ accounts: [account] }), "calendar/events.json": JSON.stringify({ version: 1, updated_at: "", events: [] }) });
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => new Response(responses.shift() ?? "", { status: input.includes("home/") ? 207 : 207, headers: { "content-type": "application/xml" } }));
    await expect(syncCalendar(vault, { account: account.id }, fetchImpl)).resolves.toMatchObject({ imported: 2, accounts: [{ id: account.id, imported: 2 }] });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://caldav.icloud.com/");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "PROPFIND", body: expect.stringContaining("current-user-principal") });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Depth: "0", "Content-Type": "text/xml", Authorization: expect.stringContaining("Basic") });
    expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({ method: "REPORT", body: expect.stringContaining("calendar-query") });
    expect(JSON.parse(files.get("calendar/events.json")!).events).toHaveLength(2);
  });

  it("writes an event to CalDAV only when explicitly requested", async () => {
    const account: CalendarAccount = { id: "dav", name: "自建日历", provider: "caldav", endpoint: "https://calendar.test/collection", user: "u", password: "p" };
    const { vault } = fakeVault({ "calendar/accounts.json": JSON.stringify({ accounts: [account] }) });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await expect(pushCalendarEvent(vault, { account: "dav", event: { id: "local-1", title: "本地会议", start: "2026-08-08T01:00:00.000Z", end: "2026-08-08T02:00:00.000Z" } }, fetchImpl)).resolves.toMatchObject({ account: "自建日历" });
    expect(fetchImpl).toHaveBeenCalledWith("https://calendar.test/collection/local-1.ics", expect.objectContaining({ method: "PUT", headers: expect.objectContaining({ Authorization: expect.stringContaining("Basic") }) }));
  });

  it("blocks outbound writes for read-only providers", async () => {
    const { vault } = fakeVault({ "calendar/accounts.json": JSON.stringify({ accounts: [ACCOUNT] }) });
    await expect(pushCalendarEvent(vault, { account: "google", event: { id: "local-1", title: "x", start: "2026-08-08T01:00:00.000Z", end: "2026-08-08T02:00:00.000Z" } })).rejects.toThrow("OAuth");
  });
});

import { createHash } from "node:crypto";
import { STREAM_SIZE, sizeTag, type Size } from "../../src/screens";
import { config } from "./config";

export type ApiSession = {
  id: string;
  sourceId: string;
  title: string;
  doNotRecord?: boolean;
  // Epoch ms from /sessions/:id, an ISO string from the /sessions list.
  slot_start?: number | string | null;
  slot_room?: { name: string } | null;
  [key: string]: unknown;
};

/** slot_start as epoch milliseconds, whichever shape the API sent. */
export function startMs(s: ApiSession): number | null {
  const v = s.slot_start;
  if (v === null || v === undefined || v === "") return null;
  const ms = typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`Session ${s.sourceId} has an unreadable slot_start: ${JSON.stringify(v)}`);
  return ms;
}

type SessionsPage = { data: { total: number; currentPage: number; items: ApiSession[] } };

/** Every session of the event, following pages until the API's total is reached. */
export async function fetchSessions(event = config.event): Promise<ApiSession[]> {
  const byId = new Map<string, ApiSession>();
  let total = Infinity;
  for (let page = 1; byId.size < total; page++) {
    const url = `${config.devconApi}/sessions?event=${encodeURIComponent(event)}&size=1000&page=${page}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const { data } = (await res.json()) as SessionsPage;
    total = data.total;
    const before = byId.size;
    for (const s of data.items) byId.set(s.id, s);
    if (byId.size === before) {
      throw new Error(`Devcon API returned ${byId.size} of ${total} sessions and stopped paging`);
    }
  }
  return [...byId.values()];
}

/**
 * Stable hash of everything the API says about a session. When it is unchanged
 * the card devcon.org renders from it is too, so the card isn't re-fetched.
 */
export function sessionHash(s: ApiSession): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash("sha256").update(JSON.stringify(canonical(s))).digest("hex");
}

/**
 * The official AV card devcon.org renders for a session at an output size:
 * the 1920x1080 intro card (the YouTube Card in Drive), or the stage screen's
 * card at that screen's own size (the Screen Card), never a crop of the first.
 */
export async function fetchCard(sessionId: string, size: Size, tries = 3): Promise<Buffer> {
  const tag = sizeTag(size);
  const url =
    tag === sizeTag(STREAM_SIZE)
      ? `${config.devconSite}/api/social/av/${sessionId}/`
      : `${config.devconSite}/api/social/av-screen/${tag}/${sessionId}/`;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("image/jpeg")) throw new Error(`expected image/jpeg, got "${type}"`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

// One pipeline run: Devcon schedule -> diff against the last run (SQLite) ->
// fetch changed cards -> render changed talks -> place them in the AV Drive.
//
// Usage:
//   pnpm sync                    # full run
//   pnpm sync RPAPTP KWXPU8      # limit render/upload to these talk codes (schedule diff still covers all)
//   pnpm sync --dry-run          # show the schedule diff and what would render; changes nothing
//   pnpm sync --no-upload        # render but don't touch Drive
//   pnpm sync --every 30         # run forever, every 30 minutes
//   pnpm sync --every 30 --port 3000   # same, plus an HTTP API to start runs on demand (the container's command)
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Talk, TalksFile } from "../src/types";
import { sizeTag, variantsFor as allVariantsFor, type Variant } from "../src/screens";
import { config } from "./lib/config";
import { Db, nowIso, type LogKind, type OutputRow, type RunRow, type TalkRow } from "./lib/db";
import { fetchCard, fetchSessions, sessionHash, startMs, type ApiSession } from "./lib/devcon";
import { AvDrive, animationFolderFor, animationName, pool, type AnimFile } from "./lib/drive";
import { Renderer, md5File, renderBaseKey, renderKey } from "./lib/render";
import { startServer } from "./lib/server";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const DRY_RUN = flag("--dry-run");
const NO_UPLOAD = flag("--no-upload");
const everyIdx = args.indexOf("--every");
const EVERY_MIN = everyIdx >= 0 ? Number(args[everyIdx + 1]) : null;
if (EVERY_MIN !== null && !(EVERY_MIN > 0)) throw new Error(`--every needs a number of minutes, got "${args[everyIdx + 1]}"`);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : null;
if (PORT !== null && !(Number.isInteger(PORT) && PORT > 0 && PORT < 65536)) throw new Error(`--port needs a port number, got "${args[portIdx + 1]}"`);
if (PORT !== null && EVERY_MIN === null) throw new Error("--port only works together with --every");
const ONLY = new Set(
  args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--every" && args[i - 1] !== "--port").map((c) => c.toUpperCase()),
);

// One card per talk and output size: the 1080p card, plus each stage screen's own.
const cardRel = (code: string, size: string) => `cards/${code}-${size}.jpg`;
const cardPath = (code: string, size: string) => path.join(config.publicDir, cardRel(code, size));
// What a video's card looks like, for its render key: only that size's card,
// so adding a size (or a stage card changing) leaves the talk's other videos
// alone. Same value as the old all-sizes hash for a talk with only a 1080p card.
const cardKey = (code: string, size: string): string | null => {
  const file = cardPath(code, size);
  return existsSync(file) ? createHash("md5").update(`${size}:${md5File(file)}`).digest("hex") : null;
};
const isActive = (t: TalkRow) => t.removed_at === null;
const variantsFor = (room: string) =>
  config.streamOnly ? allVariantsFor(room).filter((v) => v.id === "1080p") : allVariantsFor(room);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toTalk(t: TalkRow): Talk {
  return {
    code: t.code,
    id: t.session_id,
    title: t.title,
    room: t.room,
    start: t.start_ms,
    doNotRecord: t.do_not_record === 1,
    cards: Object.fromEntries(variantsFor(t.room).map((v) => [sizeTag(v), cardRel(t.code, sizeTag(v))])),
  };
}

// --- lock: one run at a time per data dir --------------------------------------

function acquireLock(): () => void {
  mkdirSync(config.dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(config.lockFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(config.lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(readFileSync(config.lockFile, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive && pid !== process.pid) throw new Error(`Another sync is running (pid ${pid}, ${config.lockFile})`);
      rmSync(config.lockFile, { force: true });
    }
  }
  throw new Error(`Could not take ${config.lockFile}`);
}

// --- one run ---------------------------------------------------------------------

async function runOnce(db: Db, dryRun: boolean, only: Set<string>): Promise<void> {
  const runId = db.startRun();
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const log = (code: string | null, kind: LogKind, before?: unknown, after?: unknown) => {
    db.log(runId, code, kind, before, after);
    bump(kind);
  };

  try {
    mkdirSync(config.cardsDir, { recursive: true });
    mkdirSync(config.outDir, { recursive: true });

    // 1. Schedule diff
    const sessions = (await fetchSessions()).filter((s) => startMs(s) !== null);
    if (sessions.length === 0) throw new Error(`Devcon API has no scheduled sessions for "${config.event}"`);
    const prevByCode = new Map(db.talks().map((t) => [t.code, t]));
    const seen = new Set<string>();
    const needCard: ApiSession[] = [];

    for (const s of sessions) {
      const code = s.sourceId;
      seen.add(code);
      const fields = {
        session_id: s.id,
        title: s.title,
        room: s.slot_room?.name ?? "",
        start_ms: startMs(s)!,
        do_not_record: s.doNotRecord ? 1 : 0,
        session_hash: sessionHash(s),
      };
      const prev = prevByCode.get(code);
      if (!prev) {
        db.insertTalk({ code, ...fields });
        log(code, "added", null, { title: fields.title, room: fields.room, start: new Date(fields.start_ms).toISOString() });
        needCard.push(s);
        continue;
      }
      if (prev.removed_at) log(code, "restored", prev.removed_at, null);
      if (prev.title !== fields.title) log(code, "title", prev.title, fields.title);
      if (prev.room !== fields.room) log(code, "room", prev.room, fields.room);
      if (prev.start_ms !== fields.start_ms)
        log(code, "time", new Date(prev.start_ms).toISOString(), new Date(fields.start_ms).toISOString());
      if (prev.do_not_record !== fields.do_not_record) log(code, "do_not_record", prev.do_not_record === 1, fields.do_not_record === 1);
      const cardsMissing = variantsFor(fields.room).some((v) => !existsSync(cardPath(code, sizeTag(v))));
      if (prev.session_hash !== fields.session_hash || !prev.card_md5 || cardsMissing) needCard.push(s);
      db.updateTalk(code, { ...fields, removed_at: null, missing_runs: 0, last_seen: nowIso() });
    }
    // The API occasionally leaves a talk out for a moment, so a talk only
    // counts as removed once it's missing from two runs in a row.
    for (const t of prevByCode.values()) {
      if (!isActive(t) || seen.has(t.code)) continue;
      const missing = t.missing_runs + 1;
      if (missing >= 2) {
        db.updateTalk(t.code, { removed_at: nowIso(), missing_runs: missing });
        log(t.code, "removed", { title: t.title, room: t.room }, null);
      } else {
        db.updateTalk(t.code, { missing_runs: missing });
      }
    }

    if (dryRun) {
      const candidates = db.talks().filter((t) => isActive(t) && !t.do_not_record && (!only.size || only.has(t.code)));
      const base = renderBaseKey();
      const stale = candidates.flatMap((t) =>
        variantsFor(t.room).filter((v) => {
          const card = cardKey(t.code, sizeTag(v));
          return !card || renderKey(base, card, v) !== db.output(t.code, sizeTag(v))?.render_key;
        }),
      );
      console.log(
        `Would fetch ${needCard.length} card(s); ${stale.length} video(s) already known to need a render ` +
          `(plus any whose card changes).`,
      );
      return;
    }

    // 2. Cards for new/changed sessions
    console.log(`Schedule: ${sessions.length} talks; fetching ${needCard.length} card(s)…`);
    await pool(needCard, 4, async (s) => {
      const code = s.sourceId;
      try {
        // Every size first, then swap them in: a failure leaves the old set whole.
        const fetched = await Promise.all(
          variantsFor(s.slot_room?.name ?? "").map(async (v) => ({ size: sizeTag(v), buf: await fetchCard(s.id, v) })),
        );
        const sums: string[] = [];
        for (const { size, buf } of fetched) {
          const tmp = `${cardPath(code, size)}.tmp`;
          writeFileSync(tmp, buf);
          sums.push(`${size}:${md5File(tmp)}`);
        }
        for (const { size } of fetched) {
          copyFileSync(`${cardPath(code, size)}.tmp`, cardPath(code, size));
          rmSync(`${cardPath(code, size)}.tmp`);
        }
        // The talk's card set as one hash: any size changing re-renders the talk.
        const md5 = createHash("md5").update(sums.join(",")).digest("hex");
        const prev = db.talk(code)!;
        if (prev.card_md5 && prev.card_md5 !== md5) log(code, "card", prev.card_md5, md5);
        db.updateTalk(code, { card_md5: md5 });
        if (prev.status?.startsWith("card:")) db.setStatus(runId, code, null);
      } catch (err) {
        db.setStatus(runId, code, `card: ${errMsg(err)}`);
        bump("problem");
      }
    });

    // Studio's talk list
    const active = db
      .talks()
      .filter((t) => isActive(t) && t.card_md5)
      .sort((a, b) => a.start_ms - b.start_ms || a.title.localeCompare(b.title));
    const studio: TalksFile = { event: config.event, talks: active.map(toTalk) };
    writeFileSync(config.studioTalks, JSON.stringify(studio, null, 2) + "\n");

    // Drive is indexed up front so each talk can be uploaded as soon as its
    // videos are rendered (a long first run fills Drive progressively).
    const drive = NO_UPLOAD ? null : new AvDrive();
    const index = drive ? await drive.index() : null;
    if (index) console.log(`Drive: ${index.rooms} rooms, ${index.cards.size} intro cards, ${index.animations.size} talks with animations`);
    else console.log("Skipping Drive (--no-upload).");
    const synced = new Set<string>();

    const syncDrive = async (code: string) => {
      if (!drive || !index || synced.has(code)) return;
      synced.add(code);
      const t = db.talk(code);
      if (!t) return;
      const copies = index.animations.get(t.code) ?? [];
      const keep = new Set<string>();
      const wanted = isActive(t) && !t.do_not_record ? variantsFor(t.room) : [];

      if (wanted.length) {
        const slot = index.cards.get(t.code);
        if (!slot) {
          if (copies.length || db.outputs(t.code).some((o) => o.out_file)) {
            db.setStatus(runId, t.code, "drive: waiting for its intro card to appear in Drive (room/day unknown)");
          }
          return;
        }
        for (const v of wanted) {
          const size = sizeTag(v);
          const out = db.output(t.code, size);
          if (!out?.out_file || !existsSync(out.out_file)) continue;
          const name = animationName(slot.cardName, size);
          const where = `${slot.where}/${animationFolderFor(size)}/${name}`;
          const sameSize = copies.filter((c) => c.size === size && !keep.has(c.id));
          const existing: AnimFile | undefined = sameSize.find((c) => c.id === out.drive_file_id) ?? sameSize[0];
          try {
            let fileId: string;
            if (existing) {
              const folderId = AvDrive.folderIdFor(slot, size);
              const needsMove = folderId === null || existing.parentId !== folderId || existing.name !== name;
              const needsContent = existing.md5 !== out.out_md5;
              if (needsMove || needsContent) await drive.update(existing, slot, size, name, needsContent ? out.out_file : null);
              if (needsMove) log(t.code, "moved", `${existing.where}/${existing.name}`, where);
              if (needsContent) log(t.code, "uploaded", existing.md5, `${size} ${out.out_md5}`);
              fileId = existing.id;
            } else {
              fileId = await drive.create(slot, size, name, out.out_file);
              log(t.code, "uploaded", null, where);
            }
            keep.add(fileId);
            db.upsertOutput(t.code, size, { drive_file_id: fileId, drive_path: where, drive_md5: out.out_md5, uploaded_at: nowIso() });
            if (db.talk(t.code)!.status?.startsWith("drive")) db.setStatus(runId, t.code, null);
          } catch (err) {
            db.setStatus(runId, t.code, `drive ${size}: ${errMsg(err)}`);
            bump("problem");
          }
        }
      }

      // Anything else for this talk is stale: removed / do-not-record talks,
      // sizes the room no longer has, and duplicates.
      for (const c of copies.filter((c) => !keep.has(c.id))) {
        if (wanted.some((v) => sizeTag(v) === c.size) && !index.cards.has(t.code)) continue;
        if (wanted.some((v) => sizeTag(v) === c.size) && !db.output(t.code, c.size)?.out_file) continue;
        try {
          await drive.trash(c.id);
          log(t.code, "trashed", `${c.where}/${c.name}`, null);
        } catch (err) {
          db.setStatus(runId, t.code, `drive: trash failed: ${errMsg(err)}`);
        }
      }
      for (const o of db.outputs(t.code)) {
        if (o.drive_file_id && !keep.has(o.drive_file_id) && !wanted.some((v) => sizeTag(v) === o.size)) {
          if (o.out_file) rmSync(o.out_file, { force: true });
          db.deleteOutput(t.code, o.size);
        }
      }
    };

    // 3. Render what changed: one video per talk and size
    const base = renderBaseKey();
    type Job = { t: TalkRow; v: Variant; out: OutputRow | undefined; key: string };
    const jobs: Job[] = active
      .filter((t) => !t.do_not_record && (!only.size || only.has(t.code)))
      .flatMap((t) =>
        variantsFor(t.room).flatMap((v) => {
          const card = cardKey(t.code, sizeTag(v));
          // No card at this size yet: its fetch failed and the talk's status says why.
          return card ? [{ t, v, out: db.output(t.code, sizeTag(v)), key: renderKey(base, card, v) }] : [];
        }),
      )
      .filter(({ out, key }) => key !== out?.render_key || !out?.out_file || !existsSync(out.out_file));
    // Talks with nothing to render get their Drive files placed now, so moves and
    // renames don't wait behind a long render queue.
    if (drive) {
      const pending = new Set(jobs.map((j) => j.t.code));
      const ready = db.talks().filter((t) => !pending.has(t.code) && (!only.size || only.has(t.code)));
      await pool(ready, 3, (t) => syncDrive(t.code));
    }

    console.log(`Rendering ${jobs.length} video(s)…`);
    const renderer = new Renderer();
    for (const [i, { t, v, out, key }] of jobs.entries()) {
      const size = sizeTag(v);
      const tag = `[${i + 1}/${jobs.length}] ${t.code} ${size}`;
      try {
        let last = -1;
        const file = await renderer.render(toTalk(t), v, (p) => {
          const pct = Math.floor(p * 10) * 10;
          if (pct !== last && process.stdout.isTTY) process.stdout.write(`\r  ${tag} ${(last = pct)}%   `);
        });
        if (out?.out_file && out.out_file !== file) rmSync(out.out_file, { force: true });
        const md5 = md5File(file);
        db.upsertOutput(t.code, size, { render_key: key, rendered_at: nowIso(), out_file: file, out_md5: md5 });
        log(t.code, "rendered", out?.out_md5 ?? null, `${size} ${md5}`);
        if (db.talk(t.code)!.status?.startsWith("render")) db.setStatus(runId, t.code, null);
        console.log(`\r  ${tag} -> ${path.relative(config.root, file)}`);
      } catch (err) {
        db.setStatus(runId, t.code, `render ${size}: ${errMsg(err)}`);
        bump("problem");
        console.error(`\r  ${tag} render failed: ${errMsg(err)}`);
      }
      if (jobs[i + 1]?.t.code !== t.code) await syncDrive(t.code);
    }


    // Sizes a talk no longer needs (its room changed screens) are dropped locally.
    for (const o of db.outputs()) {
      const t = db.talk(o.code);
      const wanted = t && isActive(t) && !t.do_not_record && variantsFor(t.room).some((v) => sizeTag(v) === o.size);
      if (!wanted && !o.drive_file_id) {
        if (o.out_file) rmSync(o.out_file, { force: true });
        db.deleteOutput(o.code, o.size);
      }
    }

    // 4. Drive: everything not handled during rendering (unchanged talks whose
    // Drive copy is missing or misplaced, removed and do-not-record talks).
    if (drive) {
      const rows = db.talks().filter((t) => !only.size || only.has(t.code));
      await pool(rows, 3, (t) => syncDrive(t.code));
    }

    db.finishRun(runId, "ok", counts);
    printRun(db, runId, counts);
  } catch (err) {
    db.finishRun(runId, "failed", counts, errMsg(err));
    throw err;
  }
}

function printRun(db: Db, runId: number, counts: Record<string, number>) {
  const entries = db.logFor({ runId });
  const interesting = entries.filter((e) => !["rendered", "uploaded"].includes(e.kind));
  for (const e of interesting.slice(0, 200)) {
    const arrow = e.before !== null || e.after !== null ? `: ${e.before ?? "∅"} → ${e.after ?? "∅"}` : "";
    console.log(`  ${e.kind.padEnd(13)} ${e.code ?? ""}${arrow}`);
  }
  if (interesting.length > 200) console.log(`  … ${interesting.length - 200} more (pnpm status --run ${runId})`);
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`);
  console.log(`Run #${runId} done: ${parts.length ? parts.join(", ") : "no changes"}`);
}

// --- dry run: diff against a throwaway copy of the database -----------------------

async function dryRun() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devcon-sync-"));
  const copy = path.join(dir, "sync.db");
  try {
    if (existsSync(config.dbFile)) {
      const src = new Db(config.dbFile);
      src.sql.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
      src.close();
    }
    const db = new Db(copy);
    await runOnce(db, true, ONLY);
    const entries = db.logFor({ runId: db.runs(1)[0].id });
    for (const e of entries.slice(0, 300)) {
      console.log(`  ${e.kind.padEnd(13)} ${e.code ?? ""}: ${e.before ?? "∅"} → ${e.after ?? "∅"}`);
    }
    if (entries.length > 300) console.log(`  … ${entries.length - 300} more`);
    console.log(`Dry run: ${entries.length} schedule change(s); nothing was written.`);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- loop: timer runs plus on-demand runs from the HTTP API -----------------------

// A queued run: "all" for a full run, or the talk codes to limit it to.
type Queued = "all" | Set<string>;

function runLabel(only: Set<string>) {
  return only.size ? `run for ${[...only].join(", ")}` : "full run";
}

async function loop(everyMin: number, port: number | null) {
  let queued: Queued | null = null;
  let current: { only: string[]; startedAt: string } | null = null;
  let lastRun: RunRow | null = null;
  let nextAt = Date.now();
  let wake: (() => void) | null = null;

  if (port !== null) {
    startServer(port, process.env.TRIGGER_TOKEN || undefined, {
      trigger(codes) {
        if (codes === null || queued === "all") queued = "all";
        else queued = new Set([...(queued ?? []), ...codes]);
        console.log(`Run requested over HTTP: ${codes ? codes.join(", ") : "full"}${current ? " (after the current run)" : ""}`);
        wake?.();
        return { queued: queued === "all" ? "all" : [...queued], running: current !== null };
      },
      status() {
        return {
          running: current,
          queued: queued === null ? null : queued === "all" ? "all" : [...queued],
          nextScheduledRun: new Date(nextAt).toISOString(),
          everyMinutes: everyMin,
          lastRun: lastRun && { ...lastRun, summary: lastRun.summary ? JSON.parse(lastRun.summary) : null },
        };
      },
    });
  }

  for (;;) {
    // Wait for the timer or an HTTP request, whichever comes first.
    if (queued === null && Date.now() < nextAt) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, nextAt - Date.now());
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }
    const only: Set<string> = queued === null || queued === "all" ? new Set() : queued;
    queued = null;
    // A full run, timed or requested, restarts the timer.
    if (only.size === 0) nextAt = Date.now() + everyMin * 60_000;

    current = { only: [...only], startedAt: nowIso() };
    console.log(`Starting ${runLabel(only)}`);
    const db = new Db(config.dbFile);
    try {
      await runOnce(db, false, only);
    } catch (err) {
      console.error(`Run failed: ${errMsg(err)}`);
    } finally {
      lastRun = db.runs(1)[0] ?? null;
      db.close();
      current = null;
    }
    if (queued === null) console.log(`Next run at ${new Date(nextAt).toISOString()}`);
  }
}

async function main() {
  if (DRY_RUN) return dryRun();
  const release = acquireLock();
  const stop = () => {
    release();
    process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (EVERY_MIN !== null) return await loop(EVERY_MIN, PORT);
    const db = new Db(config.dbFile);
    try {
      await runOnce(db, false, ONLY);
    } catch (err) {
      console.error(`Run failed: ${errMsg(err)}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

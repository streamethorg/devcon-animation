// Reads each intro's alpha channel and records when the transparent iris opens
// (average opacity starts dropping) and when the intro is fully clear. The talk
// card switches on underneath at the first, so the iris never shows black.
//
// Usage: pnpm intro   (every assets/intro-<width>x<height>.webm, one per screen size)
// Writes src/intro-meta.json, keyed by size.
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const assets = path.resolve("assets");
const output = path.resolve("src/intro-meta.json");
const inputs = readdirSync(assets)
  .map((f) => /^intro-(\d+x\d+)\.webm$/.exec(f))
  .filter((m): m is RegExpExecArray => m !== null)
  .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
if (inputs.length === 0) throw new Error(`No assets/intro-<width>x<height>.webm found in ${assets}`);

const meta: Record<string, IntroMeta> = {};
for (const [file, size] of inputs) meta[size] = measure(path.join(assets, file));
writeFileSync(output, JSON.stringify(meta, null, 2) + "\n");

type IntroMeta = { source: string; fps: number; durationInSeconds: number; revealStart: number; revealEnd: number };

function measure(input: string): IntroMeta {
  const probe = JSON.parse(
    execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,r_frame_rate:format=duration",
      "-of", "json",
      input,
    ]).toString(),
  ) as { streams: { codec_name: string; r_frame_rate: string }[]; format: { duration: string } };

  const { codec_name, r_frame_rate } = probe.streams[0];
  const [num, den] = r_frame_rate.split("/").map(Number);
  const fps = num / den;
  const durationInSeconds = Number(probe.format.duration);

  // ffmpeg's native vp9 decoder drops alpha; libvpx keeps it.
  const decoder = codec_name === "vp9" ? ["-c:v", "libvpx-vp9"] : [];
  const stats = execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      ...decoder,
      "-i", input,
      "-vf", "alphaextract,signalstats,metadata=print:file=-",
      "-f", "null", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString();

  // One block per frame: "frame:N pts:... pts_time:T" followed by key=value lines.
  const frames: { t: number; avg: number; min: number; max: number }[] = [];
  for (const block of stats.split(/^frame:/m).slice(1)) {
    const t = Number(/pts_time:([\d.]+)/.exec(block)?.[1]);
    const avg = Number(/lavfi\.signalstats\.YAVG=([\d.e+-]+)/.exec(block)?.[1]);
    const min = Number(/lavfi\.signalstats\.YMIN=([\d.]+)/.exec(block)?.[1]);
    const max = Number(/lavfi\.signalstats\.YMAX=([\d.]+)/.exec(block)?.[1]);
    if ([t, avg, min, max].some(Number.isNaN)) throw new Error(`Unparseable signalstats block: ${block.slice(0, 200)}`);
    frames.push({ t, avg, min, max });
  }
  if (frames.length === 0) throw new Error(`No frames decoded from ${input}`);

  // The iris opens at the first frame with a pixel more than half transparent.
  // The first frames only have slightly see-through edge pixels (kept black
  // until the card switches on). Average opacity reacts a few frames late on
  // the wide masters, which would show black through the opening hole.
  const baseline = frames[0].avg;
  const open = frames.find((f) => f.min < 128);
  const clear = frames.find((f) => f.max < 8);
  if (!open || !clear) {
    throw new Error(
      `${path.basename(input)} has no transparent reveal (needs an alpha channel that opens up). ` +
        `Average opacity went from ${baseline} to ${frames[frames.length - 1].avg}`,
    );
  }

  const result = {
    source: path.basename(input),
    fps,
    durationInSeconds,
    revealStart: open.t,
    revealEnd: clear.t,
  };
  console.log(
    `${result.source}: ${durationInSeconds.toFixed(3)}s @ ${fps.toFixed(3)}fps, ` +
      `iris opens ${open.t.toFixed(3)}s, fully clear ${clear.t.toFixed(3)}s`,
  );
  return result;
}

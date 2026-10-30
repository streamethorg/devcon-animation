import "dotenv/config";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

const dataDir = path.resolve(root, process.env.DATA_DIR ?? "data");

export const config = {
  root,
  event: process.env.DEVCON_EVENT ?? "devcon8",
  devconApi: process.env.DEVCON_API_URL ?? "https://api.devcon.org",
  devconSite: process.env.DEVCON_SITE_URL ?? "https://devcon.org",
  holdSeconds: positive("HOLD_SECONDS", 5),
  // Only make the 1920x1080 stream version; stage screen sizes are skipped
  // (and any already in Drive are trashed as no longer wanted).
  streamOnly: ["1", "true"].includes((process.env.STREAM_ONLY ?? "").toLowerCase()),

  // Committed inputs: one intro master per screen size, assets/intro-<width>x<height>.webm
  assetsDir: path.join(root, "assets"),
  entryPoint: path.join(root, "src/index.ts"),
  studioTalks: path.join(root, "src/talks.json"),
  // Files whose contents change what a render looks like; part of each render key
  // (with the intro master of the render's size).
  renderInputs: ["src/TalkIntro.tsx", "src/intro-meta.json"].map((f) =>
    path.join(root, f),
  ),

  // Mutable state (a persistent volume in production)
  dataDir,
  dbFile: path.join(dataDir, "sync.db"),
  lockFile: path.join(dataDir, "sync.lock"),
  publicDir: path.join(dataDir, "public"),
  cardsDir: path.join(dataDir, "public/cards"),
  outDir: path.join(dataDir, "out"),
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

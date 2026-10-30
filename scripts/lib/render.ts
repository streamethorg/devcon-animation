import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { Talk } from "../../src/types";
import { sizeTag, type Size } from "../../src/screens";
import { config } from "./config";

export const md5File = (file: string) => createHash("md5").update(readFileSync(file)).digest("hex");

const introFiles = () => readdirSync(config.assetsDir).filter((f) => /^intro-\d+x\d+\.webm$/.test(f));
const introFile = (size: Size) => path.join(config.assetsDir, `intro-${sizeTag(size)}.webm`);

// Intro masters change rarely and are large: hash each once per process.
const introMd5 = new Map<string, string>();
function introKey(size: Size): string {
  const file = introFile(size);
  if (!existsSync(file)) throw new Error(`No intro master for ${sizeTag(size)}: ${path.relative(config.root, file)}`);
  if (!introMd5.has(file)) introMd5.set(file, md5File(file));
  return introMd5.get(file)!;
}

/** Hash of everything besides the card and intro master that shapes a render: composition code, intro timings, hold length. */
export function renderBaseKey(): string {
  const h = createHash("sha256");
  for (const f of config.renderInputs) h.update(readFileSync(f));
  h.update(`hold=${config.holdSeconds}`);
  return h.digest("hex");
}

export const renderKey = (base: string, cardMd5: string, size: Size) =>
  createHash("sha256").update(`${base}:${cardMd5}:${sizeTag(size)}:${introKey(size)}`).digest("hex").slice(0, 32);

const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export const outFileFor = (talk: Pick<Talk, "code" | "title">, size: Size) =>
  path.join(config.outDir, `${talk.code}-${slugify(talk.title)}-${sizeTag(size)}.mp4`);

/** Keeps the bundle's public dir in step with the committed intro masters. */
function stagePublicDir() {
  mkdirSync(config.cardsDir, { recursive: true });
  for (const f of introFiles()) {
    const src = path.join(config.assetsDir, f);
    const staged = path.join(config.publicDir, f);
    if (!existsSync(staged) || md5File(staged) !== md5File(src)) copyFileSync(src, staged);
  }
}

export class Renderer {
  private serveUrl: Promise<string> | null = null;

  private bundled(): Promise<string> {
    if (!this.serveUrl) {
      stagePublicDir();
      this.serveUrl = bundle({ entryPoint: config.entryPoint, publicDir: config.publicDir });
    }
    return this.serveUrl;
  }

  async render(talk: Talk, size: Size, onProgress?: (p: number) => void): Promise<string> {
    const serveUrl = await this.bundled();
    const inputProps = { talk, holdSeconds: config.holdSeconds, width: size.width, height: size.height };
    const composition = await selectComposition({ serveUrl, id: "TalkIntro", inputProps });
    const file = outFileFor(talk, size);
    mkdirSync(path.dirname(file), { recursive: true });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      // The masters are tagged BT.709 and stage playback and YouTube expect it;
      // Remotion's default still converts with BT.601 (a visible colour shift).
      colorSpace: "bt709",
      audioBitrate: "320k",
      outputLocation: file,
      inputProps,
      onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
    });
    return file;
  }
}

// The AV team's Drive. Talk cards (made by devcon-api's av-assets script) live at
//   $$EVENT/<Room>/<Day N - Mon D>/YouTube Cards/HH.mm <Title> [CODE].jpg
// (called "Intro Cards" before 26 Oct)
// and animations go next to them, with the same name: the 1920x1080 stream
// version in "Intro Animation", stage screen sizes in "IRL Intro Animation":
//   $$EVENT/<Room>/<Day N - Mon D>/Intro Animation/HH.mm <Title> [CODE] (1920x1080).mp4
//   $$EVENT/<Room>/<Day N - Mon D>/IRL Intro Animation/HH.mm <Title> [CODE] (4032x1512).mp4
//
// Drive quirk (same as av-assets): the shared drive labels files the robot
// uploads from outside, and that label hides them from the robot afterwards.
// So every new file starts as a copy of the Public-labelled seed image and gets
// its real content written over it; the robot then owns it for good.
import { createReadStream } from "node:fs";
import { google, type drive_v3 } from "googleapis";
import { requireEnv } from "./config";

const EVENT_FOLDER = "$$EVENT";
const CARDS_FOLDERS = ["YouTube Cards", "Intro Cards"];
const STREAM_TAG = "1920x1080";
const ANIMATION_FOLDER = "Intro Animation";
const IRL_ANIMATION_FOLDER = "IRL Intro Animation";
/** The day subfolder an animation of this size belongs in. */
export const animationFolderFor = (size: string) => (size === STREAM_TAG ? ANIMATION_FOLDER : IRL_ANIMATION_FOLDER);
// The AV team makes some of these folders by hand ("IRL intro animation").
const sameName = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.toLowerCase();
const SEED_NAME = process.env.AV_DRIVE_SEED_NAME ?? "_public placeholder (DON'T DELETE).png";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// "... [CODE].jpg" for cards; "... [CODE] (4032x1512).mp4" for animations
// (files from before per-size renders have no size and count as 1920x1080).
const CODE_RE = /\[([A-Z0-9]+)\](?: \((\d+x\d+)\))?\.(jpg|mp4)$/;

type DriveFile = drive_v3.Schema$File;

export type CardSlot = {
  dayFolderId: string;
  // Existing animation folders of the day, by name ("Intro Animation", "IRL Intro Animation")
  animFolderIds: Record<string, string>;
  cardName: string;
  // "<Room>/<Day>" for logs
  where: string;
};

export type AnimFile = {
  id: string;
  name: string;
  size: string;
  md5: string | null;
  parentId: string | null;
  where: string;
};

export type DriveIndex = {
  cards: Map<string, CardSlot>;
  animations: Map<string, AnimFile[]>;
  rooms: number;
};

export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export class AvDrive {
  private drive: drive_v3.Drive;
  private root: string;
  private seedId: string | null = null;
  private animFolderCache = new Map<string, Promise<string>>();

  /** The folder a file of this size belongs in for this slot, if it exists yet. */
  static folderIdFor(slot: CardSlot, size: string): string | null {
    return slot.animFolderIds[animationFolderFor(size)] ?? null;
  }

  constructor() {
    const auth = new google.auth.JWT({
      email: requireEnv("GOOGLE_CLIENT_EMAIL"),
      // .env files keep the PEM's newlines as "\n"; some hosts (Coolify) escape
      // that again to "\\n" and/or keep the surrounding quotes.
      key: requireEnv("GOOGLE_PRIVATE_KEY")
        .replace(/^"|"$/g, "")
        .replace(/\\+n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    this.drive = google.drive({ version: "v3", auth });
    this.root = requireEnv("AV_DRIVE_FOLDER_ID");
  }

  private async children(parentId: string, q = ""): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${parentId}' in parents and trashed = false${q ? ` and ${q}` : ""}`,
        fields: "nextPageToken, files(id, name, mimeType, md5Checksum, parents)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 1000,
        pageToken,
      });
      out.push(...(res.data.files ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  private folders(parentId: string) {
    return this.children(parentId, `mimeType = '${FOLDER_MIME}'`);
  }

  /** Where every intro card is, and every animation already uploaded, keyed by talk code. */
  async index(): Promise<DriveIndex> {
    const eventFolder = (await this.folders(this.root)).find((f) => f.name === EVENT_FOLDER);
    if (!eventFolder) throw new Error(`"${EVENT_FOLDER}" folder not found in Drive folder ${this.root}`);
    const cards = new Map<string, CardSlot>();
    const animations = new Map<string, AnimFile[]>();
    const rooms = await this.folders(eventFolder.id!);
    await pool(rooms, 3, async (room) => {
      for (const day of await this.folders(room.id!)) {
        const sub = await this.folders(day.id!);
        const cardsFolder = sub.find((f) => CARDS_FOLDERS.includes(f.name ?? ""));
        const animFolders = [ANIMATION_FOLDER, IRL_ANIMATION_FOLDER].flatMap((name) => {
          const f = sub.find((x) => sameName(x.name, name));
          return f ? [{ name, id: f.id! }] : [];
        });
        const animFolderIds = Object.fromEntries(animFolders.map((f) => [f.name, f.id]));
        const where = `${room.name}/${day.name}`;
        if (cardsFolder) {
          for (const c of await this.children(cardsFolder.id!)) {
            const code = CODE_RE.exec(c.name ?? "")?.[1];
            if (code) cards.set(code, { dayFolderId: day.id!, animFolderIds, cardName: c.name!, where });
          }
        }
        for (const animFolder of animFolders) {
          for (const a of await this.children(animFolder.id!)) {
            const m = CODE_RE.exec(a.name ?? "");
            if (!m) continue;
            const code = m[1];
            const file: AnimFile = {
              id: a.id!,
              name: a.name!,
              size: m[2] ?? STREAM_TAG,
              md5: a.md5Checksum ?? null,
              parentId: a.parents?.[0] ?? null,
              where: `${where}/${animFolder.name}`,
            };
            animations.set(code, [...(animations.get(code) ?? []), file]);
          }
        }
      }
    });
    return { cards, animations, rooms: rooms.length };
  }

  private async seed(): Promise<string> {
    if (this.seedId) return this.seedId;
    const find = async (folderId: string, depth: number): Promise<string | null> => {
      const kids = await this.children(folderId);
      const hit = kids.find((f) => f.name === SEED_NAME && !f.mimeType?.includes("google-apps"));
      if (hit) return hit.id!;
      if (depth >= 2) return null;
      for (const f of kids.filter((k) => k.mimeType === FOLDER_MIME)) {
        const id = await find(f.id!, depth + 1);
        if (id) return id;
      }
      return null;
    };
    const id = await find(this.root, 0);
    if (!id) throw new Error(`Seed image "${SEED_NAME}" not found under the AV folder`);
    this.seedId = id;
    return id;
  }

  /** The day's folder for this size, created once even under concurrent uploads. */
  private animFolder(slot: CardSlot, size: string): Promise<string> {
    const existing = AvDrive.folderIdFor(slot, size);
    if (existing) return Promise.resolve(existing);
    const name = animationFolderFor(size);
    const key = `${slot.dayFolderId}/${name}`;
    if (!this.animFolderCache.has(key)) {
      this.animFolderCache.set(
        key,
        this.drive.files
          .create({
            requestBody: { name, mimeType: FOLDER_MIME, parents: [slot.dayFolderId] },
            fields: "id",
            supportsAllDrives: true,
          })
          .then((r) => r.data.id!),
      );
    }
    return this.animFolderCache.get(key)!;
  }

  async create(slot: CardSlot, size: string, name: string, file: string): Promise<string> {
    const target = await this.animFolder(slot, size);
    const copy = await this.drive.files.copy({
      fileId: await this.seed(),
      requestBody: { name, parents: [target] },
      fields: "id",
      supportsAllDrives: true,
    });
    await this.drive.files.update({
      fileId: copy.data.id!,
      requestBody: { name, mimeType: "video/mp4" },
      media: { mimeType: "video/mp4", body: createReadStream(file) },
      supportsAllDrives: true,
    });
    return copy.data.id!;
  }

  /** Moves/renames an existing animation and, when `file` is given, replaces its bytes. */
  async update(existing: AnimFile, slot: CardSlot, size: string, name: string, file: string | null): Promise<void> {
    const target = await this.animFolder(slot, size);
    const current = existing.parentId;
    await this.drive.files.update({
      fileId: existing.id,
      requestBody: { name, mimeType: "video/mp4" },
      addParents: current === target ? undefined : target,
      removeParents: current && current !== target ? current : undefined,
      media: file ? { mimeType: "video/mp4", body: createReadStream(file) } : undefined,
      supportsAllDrives: true,
    });
  }

  async trash(fileId: string): Promise<void> {
    await this.drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
  }
}

export const animationName = (cardName: string, size: string) => cardName.replace(/\.jpg$/, ` (${size}).mp4`);

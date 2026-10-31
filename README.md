# Devcon talk intros

Per-talk intro videos for Devcon 8: the intro animation plays, its transparent iris opens onto the talk's official AV card (from devcon.org), and the card holds. Every size has its own animation master and its own card, so nothing is scaled or cropped. Each video lands in the AV team's Drive next to the talk's intro card:

```
AV/$$EVENT/<Room>/<Day N - Mon D>/YouTube Cards/HH.mm <Title> [CODE].jpg     (devcon-api av-assets)
AV/$$EVENT/<Room>/<Day N - Mon D>/Intro Animation/HH.mm <Title> [CODE] (1920x1080).mp4   (this repo, every talk)
AV/$$EVENT/<Room>/<Day N - Mon D>/IRL Intro Animation/HH.mm <Title> [CODE] (3192x1512).mp4   (this repo, stage screen size)
```

Screen sizes per stage are in `src/screens.ts` (AV spec, 22 Oct; the same map as devcon.org's AV page and devcon-api's AV Drive pipeline). Changing a size there re-renders and renames that stage's files on the next sync. Set `STREAM_ONLY=1` to make only the 1920x1080 versions.

| Stage | Videos | Intro master |
|---|---|---|
| every talk | 1920x1080 (stream, YouTube) | `Devcon-8-India-AV-intro-animation-streaming.mov` |
| Main Stage (Lotus) | 4032x1512 and 3192x1512 (the three Lotus walls) | `…-IRL-4032x1512.mov`, `…-IRL-3192x1512.mov` |
| Lotus Stage 1, Lotus Stage 3 | 3192x1512 | `…-IRL-3192x1512.mov` |
| Lotus Stage 2 | 4032x1512 | `…-IRL-4032x1512.mov` |
| Jasmine Stage 4 | 1680x1008 | `…-IRL-1680x1008.mov` |
| Community Led Stage, CLS - Builders Room | 2016x1176 (the pavilion) | `…-IRL-2016x1176.mov` |

The card for each size is devcon.org's card at that size: `/api/social/av/<id>/` for 1920x1080 (the YouTube Card in Drive) and `/api/social/av-screen/<WxH>/<id>/` for a stage screen (the Screen Card), never the 16:9 card cropped to fit.

## How a sync run works

`pnpm sync` does one pass and records everything in SQLite (`data/sync.db`):

1. Pulls the schedule from api.devcon.org and diffs it against the last run (added, removed, title, room, time, do-not-record). A talk counts as removed after it's missing from two runs in a row.
2. Re-fetches a talk's card only when its session data changed; logs when the card image itself changed.
3. Renders only videos whose card, size, the intro clip, or the composition code changed.
4. Uploads to Drive, moving/renaming when the card moved to another room or day, and trashing animations for removed or do-not-record talks. A talk whose card isn't in Drive yet waits for the next run.

```bash
pnpm sync                  # one run
pnpm sync RPAPTP           # render/upload only these codes (diff still covers all)
pnpm sync --dry-run        # show the schedule diff, change nothing
pnpm sync --no-upload      # render without touching Drive
pnpm sync --every 30       # loop
pnpm sync --every 30 --port 3000   # loop + HTTP API to start runs on demand (what the container runs)

pnpm status                # overview, recent runs, latest changes
pnpm status --run 12       # everything that happened in run 12
pnpm status --talk RPAPTP  # one talk's state and history
pnpm status --problems     # talks stuck on something

pnpm dev                   # Remotion Studio (uses data/public, filled by sync)
```

## Setup

```bash
pnpm install
cp .env.example .env       # service account + AV folder id
pnpm sync
```

## Deploy (Coolify)

Build from this repo's `Dockerfile`, mount a persistent volume at `/data`, and set the variables from `.env.example`. The container runs `pnpm sync --every ${SYNC_EVERY_MINUTES:-30} --port ${PORT:-3000}`. One run at a time is enforced with a lock file in `/data`.

## Starting a run on demand

Set `TRIGGER_TOKEN` and the container answers on `PORT` (3000):

```bash
# full run now (restarts the timer)
curl -X POST -H "Authorization: Bearer $TRIGGER_TOKEN" https://devcon-intro.pblvrt.com/run
# only re-render/upload these talks (the schedule diff still covers all)
curl -X POST -H "Authorization: Bearer $TRIGGER_TOKEN" -H 'content-type: application/json' \
  -d '{"codes":["RPAPTP","KWXPU8"]}' https://devcon-intro.pblvrt.com/run
# running / queued / next scheduled / last run
curl -H "Authorization: Bearer $TRIGGER_TOKEN" https://devcon-intro.pblvrt.com/status
```

A request during a run is queued and starts right after it; several requests merge into one run. `GET /health` needs no token.

## Video specs

What every output looks like, and why (measured against the QuickTime masters, 30 Oct 2026):

| | Value | Why |
|---|---|---|
| Frame rate | 30 fps | the masters' rate (240 frames, 8.0 s) |
| Length | 8.33 s (250 frames) | the intro plays to the end (its audio runs past the reveal); the card holds 5 s after the iris is fully clear (`HOLD_SECONDS`) |
| Card on | 2.500 s (2.467 s on 3192x1512 and 4032x1512) | first frame with a pixel more than half transparent, so the opening iris never shows black |
| Iris fully clear | 3.333 s, all sizes | |
| Video | H.264 High, yuv420p, crf 18 (Remotion's default), BT.709 tagged | `colorSpace: "bt709"`: without it Remotion converts with BT.601 and leaves the file untagged, and players read untagged HD as BT.709, so colours shift (the card's purple badge turned visibly greener, +11 on green) |
| Audio | AAC-LC 48 kHz stereo, 320 kbit/s | up from Remotion's 128k default, near YouTube's 384k recommendation for stereo; the masters carry 48 kHz PCM, kept as Opus 256k in the webm |
| Size | about 4.7 MB at 1920x1080 | the card hold is a still image, so most of the length costs almost nothing |

Quality checks (PSNR against the masters composited over the same card, RGB, 1920x1080; 4:2:0 video itself caps out at 37.4 dB on the animation and 48.9 dB on the card):

| Render setting | Animation | Card | Player colours | File |
|---|---|---|---|---|
| Remotion defaults | 34.2 dB | 42.7 dB | shifted (untagged BT.601) | 4.9 MB |
| **BT.709, crf 18 (used)** | **34.0 dB** | **40.5 dB** | **correct** | **4.7 MB** |
| BT.709, crf 14 | 33.8 dB | 40.5 dB | correct | 8.3 MB |
| BT.709, crf 10 | 34.0 dB | 40.7 dB | correct | 14.5 MB |
| BT.709, PNG frames | 33.4 dB | 40.0 dB | correct | 4.7 MB |

More bits or lossless frames buy nothing measurable; the remaining gap on the card is Remotion's BT.709 conversion, a fair price for correct colours. Render time on an Apple Silicon Mac: about 13 s per 1920x1080 video, 15 s at 2016x1176, 12 s at 1680x1008, 53 s at 3192x1512, 66 s at 4032x1512.

## Replacing the intro animation

`assets/intro-<width>x<height>.webm` are the intros with alpha (VP9), one per size, from the QuickTime RLE masters (`Devcon-8-India-AV-intro-animation-IRL-<WxH>.mov`, and `-streaming.mov` for 1920x1080). The colour tags matter: untagged, ffmpeg converts with BT.601 but Remotion's decoder reads BT.709, so the animation's colours shift. For each master:

```bash
ffmpeg -i Devcon-8-India-AV-intro-animation-IRL-4032x1512.mov -map 0:v -map 0:a \
  -vf scale=out_color_matrix=bt709:out_range=tv,format=yuva420p \
  -colorspace bt709 -color_primaries bt709 -color_trc iec61966-2-1 -color_range tv \
  -c:v libvpx-vp9 -crf 12 -b:v 0 -deadline good -cpu-used 1 -row-mt 1 -auto-alt-ref 0 \
  -c:a libopus -b:a 256k assets/intro-4032x1512.webm
pnpm intro                 # re-reads when each iris opens/clears -> src/intro-meta.json
```

crf 12 keeps the masters visually lossless (crf 10 and 14 measured 52.4 and 50.9 dB against the RLE source at 1920x1080) at 7 to 21 MB each; the output encode is the limit, not these. A new size needs its master here, its row in `src/screens.ts`, and devcon.org rendering cards at that size.

The next sync re-renders and re-uploads every talk whose master changed.

## Moving to per-size intros (first run after this change)

- Cards are now stored per size (`cards/<CODE>-<WxH>.jpg`), so every talk's cards are fetched again (about 600 requests to devcon.org, 4 at a time). The old `cards/<CODE>.jpg` files are no longer read.
- Every video re-renders: 375 at 1920x1080, 84 at 3192x1512, 41 at 4032x1512, 60 at 2016x1176, 43 at 1680x1008 (603 in all, about 3.8 h at the Mac times above).
- Drive: existing files are replaced in place (same names); the Main Stage gains a 3192x1512 version and the Community Led Stage and CLS - Builders Room gain 2016x1176 versions.

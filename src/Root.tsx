import React from "react";
import { Composition, Folder } from "remotion";
import { DEFAULT_HOLD_SECONDS, FPS, HEIGHT, TalkIntro, WIDTH, totalFrames } from "./TalkIntro";
import type { TalkIntroProps } from "./TalkIntro";
import talksFile from "./talks.json";
import type { TalksFile } from "./types";
import { STREAM_SIZE, variantsFor } from "./screens";

// Written by pnpm sync.
const data = talksFile as unknown as TalksFile;

const shared = {
  component: TalkIntro,
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
  durationInFrames: totalFrames(FPS, DEFAULT_HOLD_SECONDS, STREAM_SIZE),
  calculateMetadata: ({ props }: { props: TalkIntroProps }) => ({
    durationInFrames: totalFrames(FPS, props.holdSeconds, props),
    width: props.width,
    height: props.height,
  }),
};

export const RemotionRoot: React.FC = () => {
  if (data.talks.length === 0) return null;
  return (
    <>
      {/* Rendered by the sync pipeline with each talk passed as inputProps. */}
      <Composition
        id="TalkIntro"
        {...shared}
        defaultProps={{ talk: data.talks[0], holdSeconds: DEFAULT_HOLD_SECONDS, ...STREAM_SIZE } satisfies TalkIntroProps}
      />
      {/* One entry per talk for browsing in Studio. */}
      <Folder name="Talks">
        {data.talks.flatMap((talk) =>
          variantsFor(talk.room).map((v) => (
            <Composition
              key={`${talk.code}-${v.width}x${v.height}`}
              id={`talk-${talk.code}-${v.width}x${v.height}`}
              {...shared}
              defaultProps={{ talk, holdSeconds: DEFAULT_HOLD_SECONDS, width: v.width, height: v.height } satisfies TalkIntroProps}
            />
          )),
        )}
      </Folder>
    </>
  );
};

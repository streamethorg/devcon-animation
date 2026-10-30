import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import introMeta from "./intro-meta.json";
import type { Talk } from "./types";
import { sizeTag, type Size } from "./screens";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DEFAULT_HOLD_SECONDS = 5;

type IntroMeta = { source: string; durationInSeconds: number; revealStart: number; revealEnd: number };

// One intro master per screen size (assets/intro-<width>x<height>.webm), made
// for that screen: nothing is scaled or cropped.
export function introFor(size: Size): IntroMeta {
  const meta = (introMeta as Record<string, IntroMeta>)[sizeTag(size)];
  if (!meta) throw new Error(`No intro master for ${sizeTag(size)} (add assets/intro-${sizeTag(size)}.webm, then pnpm intro)`);
  return meta;
}

// The intro plays to the end (its audio runs past the reveal); the card then
// stays up until holdSeconds after the iris has fully opened.
export const totalFrames = (fps: number, holdSeconds: number, size: Size) => {
  const intro = introFor(size);
  return Math.ceil(Math.max(intro.durationInSeconds, intro.revealEnd + holdSeconds) * fps);
};

export type TalkIntroProps = {
  talk: Talk;
  holdSeconds: number;
  // Output size: picks the intro master and the card made for it.
  width: number;
  height: number;
};

export const TalkIntro: React.FC<TalkIntroProps> = ({ talk, width, height }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const size = sizeTag({ width, height });
  const intro = introFor({ width, height });
  const card = talk.cards[size];
  if (!card) throw new Error(`${talk.code} has no ${size} card`);

  // The card sits under the intro at full strength from the first frame the
  // iris opens, so the opening shows the card, not black. Before that it stays
  // hidden: the intro has a few transparent pixels on its edges.
  const cardOpacity = t >= intro.revealStart ? 1 : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ opacity: cardOpacity }}>
        <Img src={staticFile(card)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <AbsoluteFill>
        <OffthreadVideo
          src={staticFile(intro.source)}
          transparent
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

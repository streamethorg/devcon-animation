// In-room LED screens (AV spec, "FINAL AS ON 22 OCT"). Talks on these stages
// get a version at each screen's exact pixel size, made from that screen's own
// intro master and devcon.org's card at that size, on top of the 1920x1080
// version every talk gets for the stream. Same room map as devcon.org's AV
// page and devcon-api's AV Drive pipeline (AV_SCREEN_SIZES).
export type Size = { width: number; height: number };
export type Screen = Size & { name: string };

export const SCREENS = {
  lotus1: { name: "Lotus 1", width: 3192, height: 1512 },
  lotus2: { name: "Lotus 2", width: 4032, height: 1512 },
  lotus3: { name: "Lotus 3", width: 3192, height: 1512 },
  jasmine2: { name: "Jasmine 2", width: 1680, height: 1008 },
  pavillion: { name: "Pavillion", width: 2016, height: 1176 },
  gamingLeaderboard: { name: "Gaming Leaderboard", width: 1792, height: 1024 },
} satisfies Record<string, Screen>;

// Devcon API room name -> screens in that room. Rooms not listed only get 1080p.
export const ROOM_SCREENS: Record<string, Screen[]> = {
  // The Main Stage uses the three Lotus walls together: both sizes.
  "Main Stage (Lotus)": [SCREENS.lotus2, SCREENS.lotus1],
  "Lotus Stage 1": [SCREENS.lotus1],
  "Lotus Stage 2": [SCREENS.lotus2],
  "Lotus Stage 3": [SCREENS.lotus3],
  "Jasmine Stage 4": [SCREENS.jasmine2],
  "Community Led Stage": [SCREENS.pavillion],
  // Same pavilion as the Community Led Stage.
  "CLS - Builders Room": [SCREENS.pavillion],
};

export const STREAM_SIZE: Size = { width: 1920, height: 1080 };

export type Variant = Size & {
  // "1080p" or "screen"
  id: "1080p" | "screen";
  label: string;
};

export function variantsFor(room: string): Variant[] {
  const stream: Variant = { id: "1080p", label: "1080p", ...STREAM_SIZE };
  const screens: Variant[] = (ROOM_SCREENS[room] ?? []).map((s) => ({ id: "screen", label: s.name, width: s.width, height: s.height }));
  return [...screens, stream];
}

export const sizeTag = (s: Size) => `${s.width}x${s.height}`;

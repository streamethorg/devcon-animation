export type Talk = {
  // Pretalx code, e.g. RPAPTP
  code: string;
  // Devcon API session id (slug), used for the devcon.org card URL
  id: string;
  title: string;
  room: string;
  // Epoch milliseconds
  start: number;
  doNotRecord: boolean;
  // Official AV card per output size ("1920x1080", "4032x1512", ...), paths under public/
  cards: Record<string, string>;
};

export type TalksFile = {
  event: string;
  talks: Talk[];
};

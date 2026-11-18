// The shape of public/data/ma.json (written by sil/ma.py). Every published deal field was found in the target's
// own SEC filings (exact-phrase full-text search); a field that was not found is null, never a guess.

export type MaGroup = "US insurer" | "Japanese insurer" | "Other non-US insurer" | "Private capital"
  | "Buyer not yet identified";

export interface MaCheck {
  field: string; // acquirer | price | cash | terms | stated_value | earlier_price:agreed | earlier_price:proposed
  phrase: string; // the exact phrase(s); "a + b" = both in the same document
  hits: number; // documents of the target's deal filings that contain it
  first: string | null;
  firstForm: string | null;
  url: string | null;
}

export interface MaDeal {
  key: string;
  cik: number;
  ticker: string;
  target: string;
  segment: string;
  status: "closed" | "pending";
  acquirer: string | null;
  acquirerType: string | null;
  group: MaGroup;
  consideration: "cash" | "stock" | "mixed" | null;
  price: number | null; // headline value per target share, USD
  earlierPrices: { price: number; kind: "agreed" | "proposed" }[];
  terms: string | null;
  announced: string | null;
  announcedBasis: string | null;
  announcedUrl: string | null;
  proxy: string | null;
  proxyForm: string | null;
  proxyUrl: string | null;
  closed: string | null;
  closedBasis: string | null;
  closedUrl: string | null;
  deregistered: string | null;
  days: number | null;
  verified: { acquirer: boolean; price: boolean; consideration: boolean };
  checks: MaCheck[];
  value: number | null; // implied equity value, USD
  valueBasis: string | null;
  shares: number | null;
  sharesAsOf: string | null;
  bookQuarter: string | null;
  commonEquity: number | null;
  preferred: number | null;
  bookPerShare: number | null;
  pb: number | null; // price / book value per common share
  roe: number | null; // target's trailing-four-quarter ROE at announcement
  cr: number | null; // target's trailing combined ratio at announcement
  npe: number | null;
  doc: { price: number | null; parent: string | null; agrees: boolean | null } | null;
  note: string | null;
  pendingForms: string | null;
  pendingSince?: string | null;
}

export interface MaEvent {
  cik: number;
  date: string;
  items: string;
  deal: string | null; // the deal it closes, if any
  stayedPublic: boolean;
  url: string | null;
}

export type ActivityField = "acq" | "div" | "gw" | "intang" | "eq" | "giEq" | "resAcq" | "n201";

export interface MaData {
  version: number;
  asOf: string;
  groups: MaGroup[];
  deals: MaDeal[];
  listed: {
    years: number[];
    count: number[]; // listed specialty carriers of the universe at each year-end (today for the current year)
    entries: number[][]; // ciks listed that year (IPO or relisting)
    exits: { cik: number; deal: string | null; group: string }[][];
  };
  events: MaEvent[];
  activity: {
    years: number[];
    unit: string;
    series: Record<string, Record<ActivityField, (number | null)[]>>; // by cik; money in USD millions
  };
  documentsRead: number;
}

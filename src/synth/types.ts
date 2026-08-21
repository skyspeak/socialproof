export type SynthTheme = {
  name: string;
  summary: string;
  soWhat: string | null;
  isNew: boolean;
  rank: number;
  itemIds: string[];
};

export type SynthPeopleMove = {
  person: string;
  fromOrg: string | null;
  toOrg: string | null;
  role: string | null;
  moveType: string;
  confidence: string;
  note: string | null;
  evidenceUrl: string | null;
  rawItemId: string | null;
  rank: number;
};

export type SynthesisOutput = {
  headline: string;
  intro: string;
  themes: SynthTheme[];
  peopleMoves: SynthPeopleMove[];
  provider: string;
};

/** Raw shape returned by the model, before we map indexes back to row ids. */
export type ModelOutput = {
  headline?: string;
  intro?: string;
  themes?: Array<{
    name?: string;
    summary?: string;
    soWhat?: string | null;
    isNew?: boolean;
    itemIndexes?: number[];
  }>;
  peopleMoves?: Array<{
    person?: string;
    fromOrg?: string | null;
    toOrg?: string | null;
    role?: string | null;
    moveType?: string;
    confidence?: string;
    note?: string | null;
    itemIndex?: number | null;
  }>;
};

export const MOVE_TYPES = new Set([
  "departure",
  "new_role",
  "founded",
  "promoted",
  "board",
  "funding",
  "layoff",
  "other",
]);

export const CONFIDENCE_LEVELS = new Set(["confirmed", "reported", "chatter"]);

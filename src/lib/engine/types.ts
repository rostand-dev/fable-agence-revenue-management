import type { ISODate } from "../dates";

export type Channel = "AIRBNB" | "BOOKING";
export const CHANNELS: Channel[] = ["AIRBNB", "BOOKING"];
export const CHANNEL_LABEL: Record<string, string> = { AIRBNB: "Airbnb", BOOKING: "Booking.com", DIRECT: "Direct", MANUEL: "Saisie manuelle", INCONNU: "Canal non identifié" };

export type ChannelEconomics = { commissionPct: number; paymentFeePct: number };

/** Modèle économique d'un logement. Toute valeur absente est `null` (inconnue), jamais zéro. */
export type EconomicModel = {
  channels: Partial<Record<Channel, ChannelEconomics>>;
  cleaningFeeChargedCents: number | null;
  cleaningCostCents: number | null;
  linenCostCents: number | null;
  nightlyVariableCostCents: number | null;
  /** Contribution minimale absolue par nuit : sous ce seuil, veto. */
  hardContributionPerNightCents: number | null;
  /** Contribution de sécurité par nuit : sert au plancher stratégique. */
  strategyContributionPerNightCents: number | null;
  /** Contribution visée par nuit vendue. */
  targetContributionPerNightCents: number | null;
  /** DEMO = valeurs de démonstration ; DECLARED = saisies par le propriétaire. */
  origin: "DEMO" | "DECLARED";
};

export type Strategy = {
  basePriceCents: number | null;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  minStay: number | null;
  objective?: string;
  positioning?: string;
  maxDiscountStackPct: number;
  maxPriceChangePct: number;
};

export type Day = {
  date: ISODate;
  state: "FREE" | "BOOKED" | "BLOCKED";
  priceCents: number | null;
  minStay: number | null;
  rule: string | null;
  marketOccupancy: number | null;
  marketAdrCents: number | null;
  pricePercentile: number | null;
  event: string | null;
};

export type Promo = {
  id: string; channel: Channel; kind: string; label: string; discountPct: number;
  stayFrom: ISODate | null; stayTo: ISODate | null; verifiedAt: Date | null;
};

export type Resa = {
  channel: string; checkIn: ISODate; checkOut: ISODate; nights: number; grossRoomCents: number;
  commissionCents: number | null; paymentFeeCents: number | null; bookedAt: ISODate; status: string;
};

export type WaterfallStep = { key: string; label: string; cents: number; source: string; kind?: "net" | "final" };
export type StackResult = {
  channel: Channel; nights: number; publishedNightlyCents: number; soldNightlyCents: number;
  cumulativeDiscountPct: number; grossRoomCents: number; netRoomCents: number; contributionCents: number;
  contributionPerNightCents: number; netAdrCents: number; steps: WaterfallStep[];
};

export type AuditRule = { code: string; label: string; outcome: "PASS" | "WARN" | "FAIL"; detail: string };
export type AuditVerdict = { verdict: "APPROVE" | "REJECT" | "NEEDS_HUMAN"; rules: AuditRule[] };

export type CandidateType =
  | "MIN_STAY_OVERRIDE" | "PRICE_OVERRIDE" | "RULE_EXCLUSION" | "BASE_PRICE_CHANGE" | "CHANNEL_PROMO"
  | "PROMO_REMOVAL" | "LISTING_AUDIT" | "INVESTIGATION" | "NO_ACTION";

export type Candidate = {
  type: CandidateType;
  label: string;
  detail: string;
  /** Agent à l'origine de l'option */
  agent: string;
  target: { system: "PRICELABS" | "BOOKING" | "AIRBNB" | "INTERNAL"; channel?: Channel };
  parameters: Record<string, any>;
  nightsTouched: number;
  priceChangePct: number | null;
  /** Simulation : état actuel et proposé sur le canal de référence */
  current: StackResult | null;
  proposed: StackResult | null;
  /** Écart de contribution attendu, hypothèse comprise ; null = non chiffrable */
  expectedDeltaCents: number | null;
  hypothesis: string;
  rollbackPlan: string;
  executionMode: "API_PRICELABS" | "MANUAL_RUNBOOK" | "INTERNAL" | "NONE";
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  audit: AuditVerdict;
  reviewAt?: ISODate;
  measurementWindowDays: number;
};

export type Cause =
  | "PRICE_HIGH" | "DEMAND_WEAK" | "BOOKING_WINDOW_NOT_OPEN" | "RESTRICTION_MISMATCH" | "VISIBILITY_CONVERSION"
  | "BASE_PRICE_LOW" | "EVENT_NOT_PRICED" | "DISCOUNT_STACK" | "FLOOR_BREACH" | "DATA_STALE";

export type Evidence = { label: string; value: string; source: string; kind: "fait" | "comparaison" | "interpretation" };
export type DiagnosisStep = { question: string; answer: string; verdict: "oui" | "non" | "inconnu" };
export type Diagnosis = {
  primary: Cause;
  primaryLabel: string;
  alternatives: { cause: Cause; label: string; why: string }[];
  confidence: number;
  confidenceNote: string;
  tree: DiagnosisStep[];
  evidence: Evidence[];
};

export type DetectedOpportunity = {
  playbook: string;
  /** Clé de dédoublonnage stable d'un jour à l'autre (fenêtre, canal) ; à défaut, la date de début */
  dedupe?: string;
  reasonCode: string;
  title: string;
  stayFrom: ISODate;
  stayTo: ISODate;
  signalText: string;
  signalSource: string;
  hypothesisText: string;
  signals: Record<string, any>;
  diagnosis: Diagnosis;
  candidates: Candidate[];
  selected: number;
  veto: boolean;
  vetoText?: string;
  urgency: number;
  expiresAt: ISODate;
};

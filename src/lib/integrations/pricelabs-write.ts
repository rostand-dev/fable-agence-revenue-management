import { createHash } from "node:crypto";
import type { ISODate } from "../dates";
import { PriceLabsError, plRequest } from "./pricelabs";
import type { DatedPrice, ListingLimits, PriceLabsWriteAdapterKind, PriceLabsWritePort, PriceLabsWriterFactory, RemoteOverride, WriteReceipt } from "./pricelabs-write-port";

/**
 * Écriture PriceLabs (épic 9, US-090). Ce module regroupe :
 * - le verrou d'environnement `PRICELABS_WRITE_ENABLED` (fermé par défaut) ;
 * - les types d'action qui s'écrivent par API (`API_WRITE_TYPES`) et le plan d'écriture d'une action (`planWrite`, pur) ;
 * - l'adaptateur HTTP (`HttpPriceLabsWriter`) : mêmes reprises et mêmes messages d'erreur que la lecture.
 * Contrat de l'API : docs/epic-9-execution-pricelabs.md.
 */

/** Variable d'environnement qui ouvre l'écriture vers un vrai compte PriceLabs. Absente ou différente de « true » : fermée. */
export const PRICELABS_WRITE_ENV = "PRICELABS_WRITE_ENABLED";
export const pricelabsWriteEnabled = (env: string | undefined = process.env[PRICELABS_WRITE_ENV]): boolean => (env ?? "").trim().toLowerCase() === "true";

export { API_WRITE_TYPES, apiWriteSupports, isApiWriteType, type ApiWriteType } from "./pricelabs-write-types";

/** Nombre maximal de dates d'un prix daté écrites en une fois (PriceLabs est tout-ou-rien : une requête plus courte limite la casse). */
export const MAX_OVERRIDE_DATES = 31;

export type WriteInput = { type: string; parameters: Record<string, any> };
export type WritePlan =
  | { kind: "LISTING_LIMITS"; limits: ListingLimits }
  | { kind: "OVERRIDES"; items: DatedPrice[] }
  | { kind: "UNSUPPORTED"; reason: string };

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Ce qu'il faut écrire chez PriceLabs pour une action. Pur : `currentPrices` est la grille relue juste avant (centimes par date, null = inconnu).
 * Même règle de prix que la simulation de démonstration : prix cible fixé (rétablissement d'un plancher) ou variation en % du prix courant, arrondi à l'euro.
 */
export function planWrite(a: WriteInput, currentPrices: Record<string, number | null> = {}, bounds?: { minCents?: number | null; maxCents?: number | null }): WritePlan {
  const p = a.parameters ?? {};
  switch (a.type) {
    case "MIN_PRICE_CHANGE":
      return isPosInt(p.minPriceCents) ? { kind: "LISTING_LIMITS", limits: { minCents: p.minPriceCents } } : { kind: "UNSUPPORTED", reason: "Prix minimum cible absent ou invalide." };
    case "BASE_PRICE_CHANGE":
      return isPosInt(p.basePriceCents) ? { kind: "LISTING_LIMITS", limits: { baseCents: p.basePriceCents } } : { kind: "UNSUPPORTED", reason: "Prix de base cible absent : l'action ne se traduit pas en valeur à écrire chez PriceLabs." };
    case "PRICE_OVERRIDE":
    case "RULE_EXCLUSION": {
      const dates: string[] = Array.isArray(p.dates) ? p.dates : [];
      if (!dates.length) return { kind: "UNSUPPORTED", reason: "Aucune date à écrire." };
      if (dates.length > MAX_OVERRIDE_DATES) return { kind: "UNSUPPORTED", reason: `Plus de ${MAX_OVERRIDE_DATES} dates : l'écriture par API est refusée, découpez l'action.` };
      const items: DatedPrice[] = [];
      for (const date of [...new Set(dates)].sort()) {
        let cents: number | null = null;
        if (a.type === "RULE_EXCLUSION" || p.restoresFloor) cents = isPosInt(p.nightlyCents) ? p.nightlyCents : null;
        else if (typeof p.changePct === "number" && Number.isFinite(p.changePct)) {
          const cur = currentPrices[date];
          cents = typeof cur === "number" && cur > 0 ? Math.round(cur * (1 + p.changePct / 100) / 100) * 100 : null;
          // le plafond et le plancher de la stratégie s'appliquent à l'écriture comme à la simulation (le prix relu peut différer de celui simulé)
          if (cents !== null && bounds?.maxCents && cents > bounds.maxCents) cents = Math.floor(bounds.maxCents / 100) * 100;
          if (cents !== null && bounds?.minCents && cents < bounds.minCents) cents = Math.ceil(bounds.minCents / 100) * 100;
        }
        if (!isPosInt(cents)) return { kind: "UNSUPPORTED", reason: `Prix cible introuvable pour le ${date} : prix courant inconnu ou paramètres incomplets. Aucune écriture.` };
        items.push({ date: date as ISODate, priceCents: cents });
      }
      return { kind: "OVERRIDES", items };
    }
    default:
      return { kind: "UNSUPPORTED", reason: "Ce type d'action ne s'écrit pas par l'API PriceLabs : procédure manuelle guidée." };
  }
}

/** Montant en centimes → valeur de l'API (unités de la devise de l'annonce, sans zéros inutiles). */
export const toUnits = (cents: number): number => cents / 100;
const unitsString = (cents: number): string => String(toUnits(cents));
/** Valeur de l'API (nombre ou texte) → centimes ; null si illisible. */
export function fromUnits(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** JSON à clés triées : même objet, même texte, donc même empreinte. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}
export const requestHash = (body: unknown): string => createHash("sha256").update(stableJson(body)).digest("hex");

/** Dérogation lue chez PriceLabs → forme interne. Les dates techniques (`created_at`, `updated_at`) sont écartées du brut conservé. */
export function mapOverride(o: any): RemoteOverride | null {
  const date = typeof o?.date === "string" ? o.date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const { created_at: _c, updated_at: _u, ...raw } = o as Record<string, unknown>;
  return { date: date as ISODate, priceCents: fromUnits(o.price), priceType: typeof o.price_type === "string" ? o.price_type : null, minStay: typeof o.min_stay === "number" ? o.min_stay : null, raw };
}
/** Réponse de lecture des dérogations : `{ overrides: [...] }`. Toute autre forme est une erreur (échec fermé), jamais « aucune dérogation ». */
export function unwrapOverrides(j: unknown): RemoteOverride[] {
  const list = (j as any)?.overrides;
  if (!Array.isArray(list)) throw new PriceLabsError("Réponse PriceLabs inattendue : liste des dérogations absente.");
  return list.map(mapOverride).filter((x): x is RemoteOverride => !!x);
}

const q = encodeURIComponent;
const DELAY = 60_000;

export class HttpPriceLabsWriter implements PriceLabsWritePort {
  readonly adapter: PriceLabsWriteAdapterKind = "HTTP";
  private retries: number; private sleep?: (ms: number) => Promise<void>;
  constructor(private apiKey: string, opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {}) { this.retries = opts.retries ?? 2; this.sleep = opts.sleep; }

  private async send(method: "POST" | "DELETE", path: string, body: unknown, summary: Record<string, unknown>): Promise<WriteReceipt> {
    let status = 0;
    await plRequest(this.apiKey, path, { method, body, timeoutMs: DELAY, onStatus: (s) => { status = s; } }, this.retries, this.sleep);
    return { method, endpoint: path, status, sentAt: new Date().toISOString(), requestHash: requestHash(body), summary, adapter: "HTTP" };
  }

  setListingLimits(id: string, pms: string, l: ListingLimits) {
    const entry: Record<string, unknown> = { id, pms };
    if (l.minCents !== undefined) entry.min = toUnits(l.minCents);
    if (l.baseCents !== undefined) entry.base = toUnits(l.baseCents);
    if (l.maxCents !== undefined) entry.max = toUnits(l.maxCents);
    return this.send("POST", "/listings", { listings: [entry] }, { listingId: id, ...l });
  }
  setPriceOverrides(id: string, pms: string, items: DatedPrice[], opts: { currency: string | null; reason: string }) {
    const overrides = items.map((i) => ({ date: i.date, price: unitsString(i.priceCents), price_type: "fixed", ...(opts.currency ? { currency: opts.currency } : {}), reason: opts.reason.slice(0, 120) }));
    return this.send("POST", `/listings/${q(id)}/overrides`, { pms, overrides }, { listingId: id, dates: items.map((i) => i.date), prices: items.map((i) => i.priceCents) });
  }
  restoreOverrides(id: string, pms: string, previous: RemoteOverride[]) {
    const overrides = previous.map((o) => o.raw);
    return this.send("POST", `/listings/${q(id)}/overrides`, { pms, overrides }, { listingId: id, dates: previous.map((o) => o.date), restored: true });
  }
  deleteOverrides(id: string, pms: string, dates: ISODate[]) {
    return this.send("DELETE", `/listings/${q(id)}/overrides`, { pms, overrides: dates.map((date) => ({ date })) }, { listingId: id, dates });
  }
  async getOverrides(id: string, pms: string, from: ISODate, to: ISODate): Promise<RemoteOverride[]> {
    const j = await plRequest(this.apiKey, `/listings/${q(id)}/overrides?pms=${q(pms)}&start_date=${from}&end_date=${to}`, { timeoutMs: DELAY }, this.retries, this.sleep);
    return unwrapOverrides(j);
  }
}

/**
 * Adaptateur utilisé par l'application. `usePriceLabsWriter` ne sert qu'aux tests (Vitest) : refusé en production, où l'adaptateur est toujours l'API HTTP
 * (l'adresse se règle par PRICELABS_API_BASE, comme pour la lecture).
 */
let override: PriceLabsWriterFactory | null = null;
export const priceLabsWriterFor: PriceLabsWriterFactory = (apiKey) => (override ? override(apiKey) : new HttpPriceLabsWriter(apiKey));
export function usePriceLabsWriter(factory: PriceLabsWriterFactory | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("usePriceLabsWriter : réservé aux tests.");
  override = factory;
}

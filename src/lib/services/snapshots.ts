import { createHash } from "node:crypto";
import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { TenantTx } from "@/db/tenant";
import { freshnessOf, type Freshness } from "../freshness";
import { PortfolioError } from "./portfolio";

/**
 * Snapshots immuables des lectures externes (US-043, blueprint §7.4, §8.1, §12.4).
 * Ce que PriceLabs a répondu est conservé tel quel, avec son horodatage, sa qualité et son origine (adaptateur réel ou simulé).
 * Les projections (calendar_days, market_days) pointent le snapshot dont elles viennent : toute valeur affichée se retrace jusqu'à sa lecture.
 */
export type SnapshotKind = "PRICING" | "MARKET" | "CONFIG";

/** JSON canonique : clés triées, pour que deux réponses identiques aient la même empreinte quel que soit l'ordre des champs. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson((v as any)[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
/** Champs que la source change à chaque lecture sans que les données changent : exclus de l'empreinte pour que la déduplication fonctionne (le payload, lui, les garde). */
const VOLATILE_KEYS = new Set(["last_refreshed_at", "last_date_pushed", "last_synced_at"]);
const stripVolatile = (v: unknown): unknown => Array.isArray(v) ? v.map(stripVolatile) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).filter(([k]) => !VOLATILE_KEYS.has(k)).map(([k, x]) => [k, stripVolatile(x)])) : v;
export const contentHash = (payload: unknown) => createHash("sha256").update(canonicalJson(stripVolatile(payload))).digest("hex");

export type NewSnapshot = {
  tenantId: string; propertyId: string; kind: SnapshotKind; source: "PRICELABS"; adapter: string;
  observedAt: Date; validFrom?: string | null; validTo?: string | null;
  payload: unknown; qualityScore: number; lineage?: Record<string, unknown>;
};

/** Réponse brute du dernier snapshot d'une nature (suit `unchangedOf`). null si aucun. Sert à comparer une lecture à la précédente. */
export async function latestPayload(tx: TenantTx, propertyId: string, kind: SnapshotKind): Promise<unknown | null> {
  const [r] = await tx.select({ payload: schema.sourceSnapshots.payload, unchangedOf: schema.sourceSnapshots.unchangedOf }).from(schema.sourceSnapshots)
    .where(and(eq(schema.sourceSnapshots.propertyId, propertyId), eq(schema.sourceSnapshots.kind, kind)))
    .orderBy(desc(schema.sourceSnapshots.observedAt), desc(schema.sourceSnapshots.createdAt)).limit(1);
  if (!r) return null;
  if (!r.unchangedOf) return r.payload ?? null;
  const [o] = await tx.select({ payload: schema.sourceSnapshots.payload }).from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.id, r.unchangedOf));
  return o?.payload ?? null;
}

/** Enregistre un snapshot dans la transaction de l'appelant. Identique au précédent : ligne sans payload qui le pointe (la fraîcheur avance, rien n'est dupliqué). */
export async function recordSnapshot(tx: TenantTx, s: NewSnapshot): Promise<{ id: string; unchanged: boolean }> {
  const hash = contentHash(s.payload);
  // l'observation est datée sous le verrou du logement : deux lectures concurrentes s'écrivent dans l'ordre réel, jamais à rebours
  const observedAt = new Date(Math.max(s.observedAt.getTime(), Date.now()));
  const [prev] = await tx.select({ id: schema.sourceSnapshots.id, hash: schema.sourceSnapshots.contentHash, unchangedOf: schema.sourceSnapshots.unchangedOf })
    .from(schema.sourceSnapshots)
    .where(and(eq(schema.sourceSnapshots.propertyId, s.propertyId), eq(schema.sourceSnapshots.kind, s.kind)))
    .orderBy(desc(schema.sourceSnapshots.observedAt), desc(schema.sourceSnapshots.createdAt)).limit(1);
  const unchangedOf = prev && prev.hash === hash ? (prev.unchangedOf ?? prev.id) : null;
  const id = newId("snap");
  await tx.insert(schema.sourceSnapshots).values({
    id, tenantId: s.tenantId, propertyId: s.propertyId, kind: s.kind, source: s.source, adapter: s.adapter, observedAt,
    validFrom: s.validFrom ?? null, validTo: s.validTo ?? null, contentHash: hash, unchangedOf, payload: unchangedOf ? null : s.payload,
    qualityScore: Math.max(0, Math.min(100, Math.round(s.qualityScore))), lineage: s.lineage ?? {},
  });
  return { id, unchanged: !!unchangedOf };
}

export type SnapshotView = {
  id: string; kind: SnapshotKind; source: string; adapter: string; observedAt: string; validFrom: string | null; validTo: string | null;
  qualityScore: number; contentHash: string; unchangedOf: string | null; lineage: Record<string, unknown>; freshness: Freshness;
};
const view = (r: Omit<typeof schema.sourceSnapshots.$inferSelect, "payload">, now: Date): SnapshotView => ({
  id: r.id, kind: r.kind as SnapshotKind, source: r.source, adapter: r.adapter, observedAt: r.observedAt.toISOString(), validFrom: r.validFrom, validTo: r.validTo,
  qualityScore: r.qualityScore, contentHash: r.contentHash, unchangedOf: r.unchangedOf, lineage: r.lineage, freshness: freshnessOf(r.kind as SnapshotKind, r.observedAt, now),
});

async function assertProperty(tenantId: string, propertyId: string) {
  const [p] = await db.select({ id: schema.properties.id }).from(schema.properties).where(and(eq(schema.properties.id, propertyId), eq(schema.properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
}

/** Dernier snapshot de chaque nature avec sa fraîcheur (un `null` = jamais lu), puis l'historique récent. Métadonnées seulement : jamais le payload brut. */
export async function getSnapshotState(tenantId: string, propertyId: string, opts: { limit?: number; now?: Date } = {}) {
  await assertProperty(tenantId, propertyId);
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), 100);
  const { payload: _p, ...meta } = getTableColumns(schema.sourceSnapshots); // jamais le payload brut : seulement les métadonnées
  const base = (extra?: ReturnType<typeof eq>) => db.select(meta).from(schema.sourceSnapshots)
    .where(and(eq(schema.sourceSnapshots.tenantId, tenantId), eq(schema.sourceSnapshots.propertyId, propertyId), extra))
    .orderBy(desc(schema.sourceSnapshots.observedAt), desc(schema.sourceSnapshots.createdAt));
  // le dernier de chaque nature est cherché à part (index property+kind+observed_at) : il ne sort jamais d'une fenêtre d'historique
  const [pricing, market, config, rows] = await Promise.all([base(eq(schema.sourceSnapshots.kind, "PRICING")).limit(1), base(eq(schema.sourceSnapshots.kind, "MARKET")).limit(1), base(eq(schema.sourceSnapshots.kind, "CONFIG")).limit(1), base().limit(limit)]);
  const one = (r: (typeof pricing)[number] | undefined) => (r ? view(r, now) : null);
  const [lp, lm, lc] = [one(pricing[0]), one(market[0]), one(config[0])];
  return { latest: { PRICING: lp, MARKET: lm, CONFIG: lc }, freshness: { PRICING: lp?.freshness ?? freshnessOf("PRICING", null, now), MARKET: lm?.freshness ?? freshnessOf("MARKET", null, now), CONFIG: lc?.freshness ?? freshnessOf("CONFIG", null, now) }, history: rows.map((r) => view(r, now)) };
}

/** Réponse brute d'un snapshot (suit `unchangedOf` quand la lecture était identique à une précédente). null si inconnu ou hors du locataire. */
export async function getSnapshotPayload(tenantId: string, snapshotId: string): Promise<{ snapshot: SnapshotView; payload: unknown } | null> {
  const [r] = await db.select().from(schema.sourceSnapshots).where(and(eq(schema.sourceSnapshots.id, snapshotId), eq(schema.sourceSnapshots.tenantId, tenantId)));
  if (!r) return null;
  let payload = r.payload;
  if (r.unchangedOf) {
    const [o] = await db.select({ payload: schema.sourceSnapshots.payload }).from(schema.sourceSnapshots).where(and(eq(schema.sourceSnapshots.id, r.unchangedOf), eq(schema.sourceSnapshots.tenantId, tenantId)));
    payload = o?.payload ?? null;
  }
  return { snapshot: view(r, new Date()), payload };
}

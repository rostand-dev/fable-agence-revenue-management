import { and, desc, eq, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import type { Strategy } from "@/lib/engine/types";
import { applyBuilderValues, builderValuesOf, diffStrategy, parseBuilderValues, type BuilderValues, type StrategyChange } from "@/lib/strategy";
import { PortfolioError, type PortfolioActor } from "./portfolio";

const { properties, strategyVersions: versions, users } = schema;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type StrategySource = "BUILDER" | "FORM" | "PRICELABS_SYNC" | "ACTION" | "ACTION_ROLLBACK" | "ROLLBACK" | "SYSTEM";
const invalid = (m: string) => new PortfolioError("INVALID", m);

/**
 * Seul point d'écriture de la stratégie (US-023) : verrouille le logement, calcule la nouvelle stratégie sur l'état réellement en base,
 * et, s'il y a un changement, l'écrit avec sa version (numéro incrémenté atomiquement) dans la transaction de l'appelant.
 * Renvoie null s'il n'y a rien à changer. Une version n'est jamais réécrite.
 */
export async function commitStrategy(tx: Tx, o: { tenantId: string; propertyId: string; next: (current: Strategy) => Strategy; source: StrategySource; createdBy: string; note?: string | null }): Promise<{ version: number; changes: StrategyChange[]; previous: Strategy; strategy: Strategy } | null> {
  const [cur] = await tx.select({ strategy: properties.strategy }).from(properties).where(and(eq(properties.id, o.propertyId), eq(properties.tenantId, o.tenantId))).for("update");
  if (!cur) return null;
  const previous = cur.strategy as Strategy, strategy = o.next(previous);
  const changes = diffStrategy(previous, strategy);
  if (!changes.length) return null;
  // Logement lancé sans version enregistrée (ex. sorti de l'onboarding) : on fige d'abord l'état de départ pour que l'historique soit complet.
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(versions).where(and(eq(versions.tenantId, o.tenantId), eq(versions.propertyId, o.propertyId)));
  if (n === 0) {
    const [pv] = await tx.select({ v: properties.strategyVersion }).from(properties).where(eq(properties.id, o.propertyId));
    if (pv.v >= 1) await tx.insert(versions).values({ id: newId("stv"), tenantId: o.tenantId, propertyId: o.propertyId, version: pv.v, strategy: previous, changes: [], source: "SYSTEM", createdBy: "system", note: "État de départ" });
  }
  const [row] = await tx.update(properties).set({ strategy, strategyVersion: sql`${properties.strategyVersion} + 1` }).where(and(eq(properties.id, o.propertyId), eq(properties.tenantId, o.tenantId))).returning({ v: properties.strategyVersion });
  await tx.insert(versions).values({ id: newId("stv"), tenantId: o.tenantId, propertyId: o.propertyId, version: row.v, strategy, changes, source: o.source, createdBy: o.createdBy, note: o.note?.trim() || null });
  return { version: row.v, changes, previous, strategy };
}

async function editable(tx: Pick<typeof db, "select">, tenantId: string, id: string, lock = false) {
  const q = tx.select().from(properties).where(and(eq(properties.id, id), eq(properties.tenantId, tenantId)));
  const [p] = lock ? await q.for("update") : await q;
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  if (p.isDemo) throw invalid("Un logement de démonstration ne se modifie pas.");
  if (p.status === "ONBOARDING") throw invalid("Ce logement est en cours de création : la stratégie se règle dans le parcours guidé.");
  return p;
}

const sameBuilder = (a: BuilderValues, b: BuilderValues) => diffStrategy(applyBuilderValues({} as Strategy, a), applyBuilderValues({} as Strategy, b)).length === 0;
/** Un brouillon est périmé seulement si les RÉGLAGES du builder ont changé depuis qu'il a été écrit (un changement de prix seul ne l'invalide pas). */
function isStale(d: NonNullable<typeof properties.$inferSelect["strategyDraft"]>, current: BuilderValues, version: number) {
  if (d.baseValues) return !sameBuilder(d.baseValues as unknown as BuilderValues, current);
  return d.baseVersion !== version;
}

export async function getStrategyState(tenantId: string, propertyId: string) {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  const current = p.strategy as Strategy;
  const published = builderValuesOf(current);
  const draft = p.strategyDraft;
  const draftValues = draft ? (parseBuilderValues(draft.values, published).ok ? { ...published, ...(draft.values as Partial<BuilderValues>) } : published) : null;
  const rows = await db.select({ id: versions.id, version: versions.version, changes: versions.changes, source: versions.source, createdBy: versions.createdBy, note: versions.note, createdAt: versions.createdAt, authorName: users.name })
    .from(versions).leftJoin(users, and(eq(users.id, versions.createdBy), eq(users.tenantId, tenantId))).where(and(eq(versions.tenantId, tenantId), eq(versions.propertyId, propertyId))).orderBy(desc(versions.version));
  return {
    name: p.name, isDemo: p.isDemo, status: p.status, version: p.strategyVersion, current, published,
    draft: draftValues && draft ? { values: draftValues, baseVersion: draft.baseVersion, at: draft.at, stale: isStale(draft, published, p.strategyVersion), changes: diffStrategy(current, applyBuilderValues(current, draftValues)) } : null,
    versions: rows.map((r) => ({ ...r, author: r.createdBy === "system" ? "Système" : r.authorName ?? "Utilisateur supprimé" })),
  };
}

/** Enregistre (ou remplace) le brouillon : aucun effet sur la stratégie en vigueur. */
export async function saveDraft(u: PortfolioActor, propertyId: string, raw: Record<string, unknown>, seenVersion?: number | null) {
  await db.transaction(async (tx) => {
    const p = await editable(tx, u.tenantId, propertyId, true);
    const published = builderValuesOf(p.strategy as Strategy);
    const r = parseBuilderValues(raw, published);
    if (!r.ok) throw invalid(r.error);
    // Mise à jour perdue : l'utilisateur a rédigé sur une version que d'autres réglages ont depuis remplacée.
    if (seenVersion != null && seenVersion !== p.strategyVersion) {
      const [seen] = await tx.select({ strategy: versions.strategy }).from(versions).where(and(eq(versions.tenantId, u.tenantId), eq(versions.propertyId, p.id), eq(versions.version, seenVersion)));
      if (!seen || !sameBuilder(builderValuesOf(seen.strategy as Strategy), published)) throw new PortfolioError("CONFLICT", `Les réglages ont changé depuis la version ${seenVersion} que vous avez sous les yeux (version ${p.strategyVersion} en vigueur) : rechargez la page avant d'enregistrer votre brouillon.`);
    }
    await tx.update(properties).set({ strategyDraft: { values: r.value, baseVersion: p.strategyVersion, baseValues: published as unknown as Record<string, unknown>, by: u.id, at: new Date().toISOString() } }).where(eq(properties.id, p.id));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "strategy.draft_saved", entity: "Property", entityId: p.id, summary: `${u.name} enregistre un brouillon de stratégie pour ${p.name}.`, payload: { baseVersion: p.strategyVersion, changes: diffStrategy(p.strategy as Strategy, applyBuilderValues(p.strategy as Strategy, r.value)).map((c) => c.key) } });
  });
}

export async function discardDraft(u: PortfolioActor, propertyId: string) {
  await db.transaction(async (tx) => {
    const p = await editable(tx, u.tenantId, propertyId, true);
    if (!p.strategyDraft) return;
    await tx.update(properties).set({ strategyDraft: null }).where(eq(properties.id, p.id));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "strategy.draft_discarded", entity: "Property", entityId: p.id, summary: `${u.name} abandonne le brouillon de stratégie de ${p.name}.` });
  });
}

/** Publie le brouillon : devient la stratégie en vigueur (nouvelle version). Refusé si la stratégie a changé depuis le brouillon. */
export async function publishDraft(u: PortfolioActor, propertyId: string, note: unknown) {
  const n = typeof note === "string" ? note.trim().slice(0, 300) : "";
  return db.transaction(async (tx) => {
    const p = await editable(tx, u.tenantId, propertyId, true);
    const d = p.strategyDraft;
    if (!d) throw invalid("Il n'y a pas de brouillon à publier.");
    if (isStale(d, builderValuesOf(p.strategy as Strategy), p.strategyVersion)) throw new PortfolioError("CONFLICT", `La stratégie a changé depuis ce brouillon (version ${d.baseVersion} → ${p.strategyVersion}) : relisez les réglages en vigueur et enregistrez de nouveau votre brouillon.`);
    const r = parseBuilderValues(d.values, builderValuesOf(p.strategy as Strategy));
    if (!r.ok) throw invalid(r.error);
    const res = await commitStrategy(tx, { tenantId: u.tenantId, propertyId: p.id, next: (s) => applyBuilderValues(s, r.value), source: "BUILDER", createdBy: u.id, note: n });
    await tx.update(properties).set({ strategyDraft: null }).where(eq(properties.id, p.id));
    if (!res) throw invalid("Le brouillon est identique à la stratégie en vigueur : rien à publier.");
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "strategy.published", entity: "Property", entityId: p.id, summary: `${u.name} publie la stratégie version ${res.version} de ${p.name}.`, payload: { version: res.version, changes: res.changes, note: n || null } });
    return res.version;
  });
}

/** Restaure les réglages d'une version antérieure comme NOUVELLE version (l'historique n'est jamais réécrit). Les prix ne sont pas restaurés. */
export async function rollbackToVersion(u: PortfolioActor, propertyId: string, version: unknown, note: unknown) {
  const v = typeof version === "number" ? version : Number(version);
  if (!Number.isInteger(v) || v < 1) throw invalid("Version à restaurer inconnue.");
  const n = typeof note === "string" ? note.trim().slice(0, 300) : "";
  return db.transaction(async (tx) => {
    const p = await editable(tx, u.tenantId, propertyId, true);
    const [target] = await tx.select().from(versions).where(and(eq(versions.tenantId, u.tenantId), eq(versions.propertyId, p.id), eq(versions.version, v)));
    if (!target) throw new PortfolioError("NOT_FOUND", "Cette version n'existe pas pour ce logement.");
    if (v === p.strategyVersion) throw invalid("Cette version est déjà en vigueur.");
    const values = builderValuesOf(target.strategy as Strategy);
    const res = await commitStrategy(tx, { tenantId: u.tenantId, propertyId: p.id, next: (s) => applyBuilderValues(s, values), source: "ROLLBACK", createdBy: u.id, note: n || `Restauration des réglages de la version ${v}` });
    await tx.update(properties).set({ strategyDraft: null }).where(eq(properties.id, p.id));
    if (!res) throw invalid(`Les réglages de la version ${v} sont déjà ceux en vigueur : rien à restaurer.`);
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "strategy.rolled_back", entity: "Property", entityId: p.id, summary: `${u.name} restaure les réglages de la version ${v} de ${p.name} (nouvelle version ${res.version}).`, payload: { restoredFrom: v, version: res.version, changes: res.changes, note: n || null } });
    return res.version;
  });
}

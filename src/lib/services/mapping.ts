import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { evaluateMapping, type MappingEvaluation, type MappingFacts } from "@/lib/mapping";
import { PortfolioError, type PortfolioActor } from "./portfolio";

const { properties, listings } = schema;
type Ex = Pick<typeof db, "select">;

/** Ce qu'on sait du rattachement d'un logement, lu en base pour son espace seulement. */
async function loadFacts(ex: Ex, tenantId: string, propertyId: string, lock = false) {
  const q = ex.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  const [p] = lock ? await q.for("update") : await q;
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  const ls = await ex.select({ channel: listings.channel, externalId: listings.externalId }).from(listings).where(and(eq(listings.tenantId, tenantId), eq(listings.propertyId, propertyId), eq(listings.status, "ACTIVE")));
  const plc = p.pricelabs?.listingId ? (p.pricelabs.candidates ?? []).find((c: any) => String(c.id) === String(p.pricelabs!.listingId)) : null;
  const shc = p.superhote?.rentalId ? (p.superhote.candidates ?? []).find((c: any) => String(c.id) === String(p.superhote!.rentalId)) : null;
  const facts: MappingFacts = {
    property: { name: p.name, city: p.city, bedrooms: p.bedrooms, capacity: p.capacity },
    superhote: p.superhote?.rentalId ? { rentalId: String(p.superhote.rentalId), rentalName: p.superhote.rentalName ?? null, city: shc?.city ?? null, capacity: typeof shc?.capacity === "number" ? shc.capacity : null } : null,
    pricelabs: p.pricelabs?.listingId ? { listingId: String(p.pricelabs.listingId), pms: p.pricelabs.pms ?? null, listingName: p.pricelabs.listingName ?? null, city: plc?.city ?? null, bedrooms: typeof plc?.bedrooms === "number" ? plc.bedrooms : null } : null,
    listings: ls,
    confirmation: p.mapping ? { fingerprint: p.mapping.fingerprint, at: p.mapping.at, by: p.mapping.by } : null,
  };
  return { p, facts };
}

export type MappingView = MappingEvaluation & { confirmedAt: string | null; isDemo: boolean };

export async function getMapping(tenantId: string, propertyId: string): Promise<MappingView> {
  const { p, facts } = await loadFacts(db, tenantId, propertyId);
  const e = evaluateMapping(facts);
  return { ...e, confirmedAt: e.status === "CONFIRMED" ? p.mapping!.at : null, isDemo: p.isDemo };
}

/**
 * Confirmation du mapping par une personne. Refusée tant que l'annonce PriceLabs manque ; en cas de doute détecté
 * (ville, chambres, capacité), la personne doit déclarer l'avoir vérifié, et les doutes sont gardés dans le journal.
 */
export async function confirmMapping(u: PortfolioActor, propertyId: string, acknowledge: boolean, seenFingerprint: unknown) {
  await db.transaction(async (tx) => {
    const { p, facts } = await loadFacts(tx, u.tenantId, propertyId, true); // verrou : deux confirmations simultanées ne s'écrasent pas
    if (p.isDemo) throw new PortfolioError("INVALID", "Un logement de démonstration n'a pas de mapping à confirmer.");
    const e = evaluateMapping(facts);
    if (!e.confirmable) throw new PortfolioError("INVALID", "Rattachez d'abord l'annonce PriceLabs de ce logement.");
    // la personne confirme ce qu'elle a vu : si quelque chose a changé depuis l'affichage, elle relit d'abord
    if (typeof seenFingerprint !== "string" || seenFingerprint !== e.fingerprint) throw new PortfolioError("CONFLICT", "Les rattachements ont changé depuis l'affichage de cette page : rechargez-la et relisez avant de confirmer.");
    if (e.status === "CONFIRMED") return;
    if (e.checks.length && !acknowledge) throw new PortfolioError("INVALID", "Des écarts sont signalés : cochez « J'ai vérifié ces écarts » pour confirmer malgré eux, ou corrigez le rattachement.");
    const warnings = e.checks.map((c) => c.message);
    await tx.update(properties).set({ mapping: { fingerprint: e.fingerprint, at: new Date().toISOString(), by: u.id, warnings } }).where(and(eq(properties.id, p.id), eq(properties.tenantId, u.tenantId)));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "mapping.confirmed", entity: "Property", entityId: p.id, summary: `${u.name} confirme le mapping des identifiants de ${p.name}${warnings.length ? ` malgré ${warnings.length} écart${warnings.length > 1 ? "s" : ""} signalé${warnings.length > 1 ? "s" : ""}` : ""}.`, payload: { fingerprint: e.fingerprint, warnings, items: e.items.map((i) => ({ key: i.key, value: i.value })) } });
  });
}

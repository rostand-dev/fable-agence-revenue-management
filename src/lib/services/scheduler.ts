import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { todayISO, type ISODate } from "../dates";
import { reservationChanges } from "../engine/cadence";
import { refreshCadence } from "./cadence";
import { syncPriceLabs } from "./pricelabs-sync";
import { runDailyReview } from "./review";
import { resolveFlag, type FlagRow } from "../flags/catalog";
import { refreshSuperhoteReservations } from "./superhote-sync";

const { properties, reservations, agentRuns } = schema;
type Prop = typeof properties.$inferSelect;
type DueField = "nextReservationsAt" | "nextPricesAt" | "nextReviewAt";
const COL = { nextReservationsAt: properties.nextReservationsAt, nextPricesAt: properties.nextPricesAt, nextReviewAt: properties.nextReviewAt };
/** Pendant qu'un passage est en cours, l'échéance est repoussée de ce délai : un second serveur ne le relance pas. */
const LEASE_MS = 30 * 60000;

/** Réserve un passage arrivé à échéance. Atomique : un seul appelant l'obtient, même avec plusieurs instances du serveur. */
async function claim(field: DueField, id: string, now: Date): Promise<boolean> {
  const col = COL[field];
  const rows = await db.update(properties).set({ [field]: new Date(+now + LEASE_MS) } as Partial<Prop>).where(and(eq(properties.id, id), or(isNull(col), lte(col, now)))).returning({ id: properties.id });
  return rows.length > 0;
}

/** Réservations à venir ou en cours, par identifiant externe : sert à repérer une réservation nouvelle ou annulée entre deux lectures. */
async function liveReservations(propertyId: string, today: ISODate): Promise<Set<string>> {
  const rows = await db.select({ ext: reservations.externalId }).from(reservations).where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, "CONFIRMED"), gte(reservations.checkOut, today)));
  return new Set(rows.map((r) => r.ext));
}

const due = (d: Date | null, now: Date) => !d || +d <= +now;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Un logement : lectures arrivées à échéance, puis revue si elle est due ou si une réservation a changé. */
async function processProperty(p: Prop, now: Date, flags: FlagRow[]): Promise<{ read: boolean; reviewed: boolean }> {
  // US-013 : un drapeau coupé (propriétaire, logement ou intégration) arrête la lecture ou la revue automatique ; l'échéance reste due, rien n'est perdu
  const syncOn = (provider: string) => resolveFlag("sync.scheduled", flags, { propertyId: p.id, provider }).enabled;
  const hasPl = !p.isDemo && !!p.pricelabs?.listingId && !!p.pricelabs?.apiKeyEnc && syncOn("pricelabs");
  const hasSh = !p.isDemo && !!p.superhote?.rentalId && !!p.superhote?.apiKeyEnc && syncOn("superhote");
  const reviewOn = resolveFlag("review.scheduled", flags, { propertyId: p.id }).enabled;
  const today = todayISO(now);
  let read = false, change: { added: number; cancelled: number } | null = null;

  const pricesDue = hasPl && due(p.nextPricesAt, now), resaDue = hasSh && due(p.nextReservationsAt, now);
  if (pricesDue || resaDue) {
    const before = await liveReservations(p.id, today);
    if (pricesDue) {
      // la lecture PriceLabs relit aussi SuperHote (contrôle croisé) : elle vaut pour les deux échéances
      if (await claim("nextPricesAt", p.id, now)) {
        if (hasSh) await db.update(properties).set({ nextReservationsAt: new Date(+now + LEASE_MS) }).where(eq(properties.id, p.id));
        try { await syncPriceLabs(p.tenantId, p.id, { skipSuperhote: !syncOn("superhote") }); } catch { /* consigné dans la dernière lecture ; nouvelle tentative selon le délai croissant */ }
        read = true;
      }
    } else if (await claim("nextReservationsAt", p.id, now)) {
      await refreshSuperhoteReservations(p.tenantId, p.id);
      read = true;
    }
    if (read) {
      const c = reservationChanges(before, await liveReservations(p.id, today));
      // une première lecture remplit le calendrier : ce n'est pas un changement à signaler
      if (before.size > 0 && c.added + c.cancelled > 0) change = c;
      await refreshCadence(p.tenantId, p.id, {}, now);
    }
  }

  // revue coupée : l'échéance reste due et reprend à la réactivation (un changement de réservation survenu entre-temps n'a plus son motif « événement »)
  if (!reviewOn) return { read, reviewed: false };
  const [cur] = await db.select({ next: properties.nextReviewAt }).from(properties).where(eq(properties.id, p.id));
  if (!cur) return { read, reviewed: false };
  let reviewed = false;
  if (change) {
    await db.update(properties).set({ nextReviewAt: new Date(+now + LEASE_MS) }).where(eq(properties.id, p.id));
    const what = [c0(change.added, "nouvelle réservation", "nouvelles réservations"), c0(change.cancelled, "annulation", "annulations")].filter(Boolean).join(" et ");
    await db.insert(agentRuns).values({ id: newId("run"), tenantId: p.tenantId, agentId: "onboarding", operation: "detectChange", mode: "DETERMINISTIC", summary: `${p.name} : ${what} à la lecture. Revue du logement relancée sans attendre son échéance.` });
    await runDailyReview(p.tenantId, "EVENT", { propertyIds: [p.id], skipSync: true });
    reviewed = true;
  } else if (due(cur.next, now) && (await claim("nextReviewAt", p.id, now))) {
    await runDailyReview(p.tenantId, "SCHEDULED", { propertyIds: [p.id], skipSync: true });
    reviewed = true;
  }
  return { read, reviewed };
}
const c0 = (n: number, one: string, many: string) => (n > 0 ? plural(n, one, many) : "");

const g = globalThis as unknown as { __nsSchedulerBusy?: boolean };

/**
 * Planification interne, appelée toutes les quinze minutes : chaque logement est relu et revu à son propre rythme
 * (voir engine/cadence). Un passage à la fois par serveur ; une erreur sur un logement n'arrête pas les autres.
 */
export async function runDue(now = new Date()): Promise<{ read: number; reviewed: number }> {
  if (g.__nsSchedulerBusy) return { read: 0, reviewed: 0 };
  g.__nsSchedulerBusy = true;
  let read = 0, reviewed = 0;
  try {
    const props = await db.select().from(properties);
    // un seul chargement des drapeaux coupés pour tout le passage
    const off = await db.select().from(schema.featureFlags).where(eq(schema.featureFlags.enabled, false));
    const byTenant = new Map<string, FlagRow[]>();
    for (const r of off) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), { flag: r.flag, scope: r.scope as FlagRow["scope"], scopeId: r.scopeId, enabled: r.enabled }]);
    for (const p of props) {
      try { const r = await processProperty(p, now, byTenant.get(p.tenantId) ?? []); if (r.read) read++; if (r.reviewed) reviewed++; }
      catch (e) { console.error("[planificateur]", p.id, e instanceof Error ? e.message : e); }
    }
  } finally { g.__nsSchedulerBusy = false; }
  return { read, reviewed };
}

import { commitStrategy } from "./strategy";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "../audit/log";
import { addDays, todayISO } from "../dates";
import type { EconomicModel, Strategy } from "../engine/types";
import { horizon, priceLabsFor, PriceLabsError } from "../integrations/pricelabs";
import { listingDrift, runConnectionCheck, type ConnectionReport } from "../integrations/pricelabs-check";
import { mapChannel, mapMarket, mapPrices, mapReservations, type ChannelOverride } from "../integrations/pricelabs-map";
import { channelHints, compareReservations, comparePriceSeries, observedCommission as shObservedCommission, observedPaymentFee } from "../integrations/superhote-map";
import { decryptSecret, encryptSecret, secretHint } from "../secret";
import { shReservations } from "../integrations/superhote-reservations";
import { replaceReservations } from "./reservations-store";
import { applyCalendarEffect, lockProperty, reconcileReservations, type ReconcileResult } from "./reservation-ingest";
import { withTenant } from "@/db/tenant";
import { snapshotSuperhote } from "./superhote-read";

const { properties, calendarDays, marketDays, reservations, agentRuns } = schema;
export class SyncError extends Error {}

async function getProp(tenantId: string, id: string) {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, id), eq(properties.tenantId, tenantId)));
  if (!p) throw new SyncError("Logement introuvable.");
  if (p.isDemo) throw new SyncError("Un logement de démonstration ne se connecte pas à PriceLabs.");
  return p;
}
const wrap = (e: unknown) => (e instanceof PriceLabsError || e instanceof SyncError ? e.message : e instanceof Error && e.message.startsWith("APP_SECRET") ? e.message : "Erreur technique pendant la lecture PriceLabs.");

/** Annonces PriceLabs déjà rattachées à un autre logement du même propriétaire : clé « id|pms » → nom du logement. */
export async function linkedElsewhere(tenantId: string, propertyId: string): Promise<Map<string, string>> {
  const others = await db.select({ name: properties.name, pl: properties.pricelabs }).from(properties).where(and(eq(properties.tenantId, tenantId), ne(properties.id, propertyId)));
  return new Map(others.filter((o) => o.pl?.listingId).map((o) => [`${o.pl!.listingId}|${o.pl!.pms}`, o.name]));
}

/**
 * Enregistre la clé (chiffrée) après l'avoir vérifiée auprès de PriceLabs.
 * Aucune annonce n'est rattachée ici, même s'il n'y en a qu'une : le propriétaire confirme toujours le rattachement.
 */
export async function connectPriceLabs(tenantId: string, propertyId: string, apiKeyRaw: string, actor: string): Promise<{ listings: number }> {
  const p = await getProp(tenantId, propertyId);
  const apiKey = apiKeyRaw.trim();
  if (apiKey.length < 20 || /\s/.test(apiKey)) throw new SyncError("Cette clé ne ressemble pas à une clé API PriceLabs. Copiez-la en entier depuis PriceLabs.");
  let listings;
  try { listings = await priceLabsFor(apiKey).listListings(); } catch (e) { throw new SyncError(wrap(e)); }
  if (listings.length === 0) throw new SyncError("La clé est valide, mais ce compte PriceLabs ne contient aucune annonce.");
  await db.update(properties).set({
    pricelabs: { apiKeyEnc: encryptSecret(apiKey), keyHint: secretHint(apiKey), connectedAt: new Date().toISOString(), candidates: listings.map((l) => ({ id: l.id, pms: l.pms, name: l.name, city: l.city, bedrooms: l.bedrooms })), listingId: null, pms: null, listingName: null },
  }).where(eq(properties.id, p.id));
  await recordAudit(db, { tenantId, actor, type: "integration.pricelabs_connected", entity: "Property", entityId: p.id, summary: `Clé API PriceLabs enregistrée pour ${p.name} (${secretHint(apiKey)}), ${listings.length} annonce${listings.length > 1 ? "s" : ""} sur le compte. Rattachement à confirmer.`, payload: { keyHint: secretHint(apiKey), listings: listings.length } });
  return { listings: listings.length };
}

/** Rattachement confirmé par le propriétaire. Une annonce ne peut être liée qu'à un seul de ses logements. */
export async function selectListing(tenantId: string, propertyId: string, listingId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  const c = (p.pricelabs?.candidates ?? []).find((x: any) => x.id === listingId);
  if (!p.pricelabs?.apiKeyEnc || !c) throw new SyncError("Annonce inconnue pour cette clé.");
  const taken = (await linkedElsewhere(tenantId, p.id)).get(`${c.id}|${c.pms}`);
  if (taken) throw new SyncError(`Cette annonce PriceLabs est déjà rattachée à votre logement « ${taken} ». Une annonce ne peut alimenter qu'un seul logement.`);
  await db.update(properties).set({ pricelabs: { ...p.pricelabs, listingId: c.id, pms: c.pms, listingName: c.name } }).where(eq(properties.id, p.id));
  await recordAudit(db, { tenantId, actor, type: "integration.pricelabs_listing_linked", entity: "Property", entityId: p.id, summary: `Annonce PriceLabs « ${c.name} » (${c.id} · ${c.pms}) rattachée à ${p.name}.`, payload: { listingId: c.id, pms: c.pms, listingName: c.name } });
  await syncPriceLabs(tenantId, p.id);
}

/** Détache l'annonce sans supprimer la clé, pour en choisir une autre. Les données déjà lues sont conservées jusqu'à la prochaine lecture. */
export async function detachListing(tenantId: string, propertyId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  if (!p.pricelabs?.apiKeyEnc) throw new SyncError("Aucune clé PriceLabs sur ce logement.");
  let candidates = p.pricelabs.candidates ?? [];
  try { candidates = (await priceLabsFor(decryptSecret(p.pricelabs.apiKeyEnc)).listListings()).map((l) => ({ id: l.id, pms: l.pms, name: l.name, city: l.city, bedrooms: l.bedrooms })); } catch { /* liste précédente conservée */ }
  const { lastSync, ...rest } = p.pricelabs;
  await db.update(properties).set({ pricelabs: { ...rest, candidates, listingId: null, pms: null, listingName: null } }).where(eq(properties.id, p.id));
  await recordAudit(db, { tenantId, actor, type: "integration.pricelabs_listing_unlinked", entity: "Property", entityId: p.id, summary: `Annonce PriceLabs détachée de ${p.name}.`, payload: { listingId: p.pricelabs?.listingId ?? null } });
}

export async function disconnectPriceLabs(tenantId: string, propertyId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  await db.update(properties).set({ pricelabs: null }).where(eq(properties.id, p.id));
  await recordAudit(db, { tenantId, actor, type: "integration.pricelabs_disconnected", entity: "Property", entityId: p.id, summary: `Clé API PriceLabs supprimée pour ${p.name}. Les données déjà lues sont conservées.` });
}

/**
 * Lecture PriceLabs d'un logement : grille J+0 à J+90, marché, réservations relayées par le PMS, réglages de prix.
 * Lecture seule. En cas d'échec, les données précédentes sont conservées et l'erreur est consignée.
 */
/** `skipSuperhote` : lecture SuperHote coupée (US-013) ; PriceLabs se lit seul, les réservations déjà enregistrées sont conservées. */
export async function syncPriceLabs(tenantId: string, propertyId: string, opts: { skipSuperhote?: boolean } = {}): Promise<{ days: number; reservations: number }> {
  const p = await getProp(tenantId, propertyId);
  const pl = p.pricelabs;
  if (!pl?.apiKeyEnc || !pl.listingId || !pl.pms) throw new SyncError("Aucune annonce PriceLabs n'est rattachée à ce logement.");
  const now = new Date(), today = todayISO(now), h = horizon(today);
  const fail = async (msg: string) => {
    await db.update(properties).set({ pricelabs: { ...pl, lastSync: { ok: false, at: now.toISOString(), error: msg } } }).where(eq(properties.id, p.id));
    await db.insert(agentRuns).values({ id: newId("run"), tenantId, agentId: "onboarding", operation: "syncPriceLabs", mode: "DETERMINISTIC", summary: `${p.name} : lecture PriceLabs en échec. Les données précédentes sont conservées.`, error: msg });
    return new SyncError(msg);
  };
  let apiKey: string;
  try { apiKey = decryptSecret(pl.apiKeyEnc); } catch { throw await fail("La clé enregistrée est illisible (APP_SECRET a changé ?). Saisissez-la de nouveau."); }

  const port = priceLabsFor(apiKey);
  let listing, priceItem, resaRows, market: any = null, marketError: string | null = null;
  try {
    listing = (await port.listListings()).find((l) => l.id === pl.listingId && l.pms === pl.pms);
    if (!listing) throw new PriceLabsError("L'annonce rattachée n'existe plus sur ce compte PriceLabs.");
    priceItem = await port.getPrices(pl.listingId, pl.pms, h.from, h.to);
    resaRows = await port.getReservations(pl.listingId, pl.pms, h.histFrom, h.histTo);
  } catch (e) { throw await fail(wrap(e)); }
  // le marché est utile mais pas bloquant : sans lui, les signaux de rythme restent « inconnus »
  try { market = await port.getNeighborhood(pl.listingId, pl.pms); } catch (e) { marketError = wrap(e); }

  // SuperHote (facultatif, lecture seule, jamais bloquant) : canal des réservations transmises sans canal + comparaison des prix
  const sh = opts.skipSuperhote ? null : await snapshotSuperhote(p.superhote, now);
  const hints = sh?.ok ? channelHints(resaRows as any[], sh.reservations, (c) => mapChannel(c) !== "INCONNU") : {};
  const model = p.economics as EconomicModel;
  const plResas = mapReservations(resaRows, model, { ...hints, ...(pl.overrides ?? {}) });
  // SuperHote fait foi pour les réservations dès qu'il est rattaché (PriceLabs les relaie avec des montants arrondis, des doublons et des manques).
  // Rattaché mais illisible : on garde les réservations déjà enregistrées, PriceLabs ne les remplace pas.
  const shLinked = !!p.superhote?.rentalId;
  const fromSh = sh?.ok ? shReservations(sh.reservations, model) : null;
  const toWrite = shLinked ? fromSh : plResas;
  const source = shLinked ? ("SUPERHOTE" as const) : ("PRICELABS" as const);
  const resas = toWrite ?? plResas;
  let days = mapPrices(priceItem).filter((d) => d.date >= h.from && d.date <= h.to);
  if (days.length === 0) throw await fail("PriceLabs n'a renvoyé aucun prix sur les 90 prochains jours.");
  // une réservation confirmée à 0 € est un blocage propriétaire : ces nuits sortent du disponible
  const blocked = new Set<string>();
  for (const r of resas) if (r.status === "BLOCKED") for (let d = r.checkIn; d < r.checkOut; d = addDays(d, 1)) blocked.add(d);
  days = days.map((d) => (blocked.has(d.date) ? { ...d, state: "BLOCKED" as const, priceCents: null, sentPriceCents: null } : d));
  // SuperHote fait foi pour le prix : son prix de calendrier (avant majoration par canal) remplace le prix recommandé PriceLabs sur les nuits libres.
  // Rattaché mais illisible, ou nuit sans prix chez SuperHote : on garde `price` PriceLabs (recommandé), jamais `user_price`.
  let pricesFromSuperhote = 0;
  if (shLinked && sh?.ok) {
    const shByDate = new Map(sh.calendar.map((n) => [n.date, n]));
    days = days.map((d) => {
      const n = shByDate.get(d.date);
      if (d.state !== "FREE" || !n || !n.available || n.reservationId || n.priceCents === null || n.priceCents <= 0) return d;
      pricesFromSuperhote++;
      return { ...d, priceCents: n.priceCents };
    });
  }
  const freeNights = days.filter((d) => d.state === "FREE").length;
  const priceSource: "SUPERHOTE" | "PRICELABS" = pricesFromSuperhote > 0 && pricesFromSuperhote >= freeNights / 2 ? "SUPERHOTE" : "PRICELABS";
  const shLastSync = !sh ? null : sh.ok
    ? { ok: true, at: sh.at, reservations: sh.reservations.filter((r) => !r.canceled).length, nights: sh.calendar.length, autoChannels: Object.keys(hints).length, priceCheck: comparePriceSeries(sh.calendar, days.map((d) => ({ date: d.date, state: d.state, sentPriceCents: d.recommendedPriceCents ?? null }))), observedCommission: shObservedCommission(sh.reservations), observedPaymentFee: observedPaymentFee(sh.reservations), reservationCheck: compareReservations(sh.reservations, resaRows as any[], { from: h.histFrom, to: h.histTo }) }
    : { ok: false, at: sh.at, error: sh.error };
  const bedrooms = p.bedrooms ?? listing.bedrooms;
  const mk = mapMarket(market, bedrooms, days);
  // US-040 : l'annonce rattachée a-t-elle changé chez PriceLabs ? Les données du rattachement suivent PriceLabs, et le changement est journalisé.
  const prevCand = (pl.candidates ?? []).find((c: any) => c.id === pl.listingId);
  const drift = listingDrift(prevCand ? { name: prevCand.name ?? null, city: prevCand.city ?? null, bedrooms: typeof prevCand.bedrooms === "number" ? prevCand.bedrooms : null } : null, listing);
  const fresh = { id: listing.id, pms: listing.pms, name: listing.name, city: listing.city, bedrooms: listing.bedrooms };
  const candidates = prevCand ? (pl.candidates as any[]).map((c) => (c.id === pl.listingId ? fresh : c)) : [...(pl.candidates ?? []), fresh];

  const strat = p.strategy as Strategy;
  const confirmed = resas.filter((r) => r.status === "CONFIRMED");
  // taux réellement constatés quand le PMS transmet la commission : proposés au propriétaire, jamais appliqués d'office
  const observedCommission: Record<string, { pct: number; n: number }> = {};
  for (const ch of ["AIRBNB", "BOOKING"]) {
    const rows = (resaRows as any[]).map((r) => ({ c: Number(r.ota_commission), g: Number(r.total_cost), ch: mapChannel(r.booking_channel), ok: !String(r.booking_status ?? "").toLowerCase().startsWith("cancel") })).filter((x) => x.ok && x.ch === ch && x.c > 0 && x.g > 0);
    if (rows.length) observedCommission[ch] = { pct: Math.round((rows.reduce((a, x) => a + x.c, 0) / rows.reduce((a, x) => a + x.g, 0)) * 1000) / 10, n: rows.length };
  }
  const lastSync = {
    ok: true, at: now.toISOString(), reservationsSource: toWrite ? source : "CONSERVEES", priceSource, pricesFromSuperhote, observedCommission, days: days.length, unknownPrices: days.filter((d) => d.state === "FREE" && d.priceCents === null).length,
    reservations: confirmed.length, cancelled: resas.filter((r) => r.status === "CANCELLED").length, ownerBlocks: resas.filter((r) => r.status === "BLOCKED").length, duplicates: resas.filter((r) => r.status === "DUPLICATE").length,
    historyFrom: confirmed.map((r) => r.checkIn).sort()[0] ?? null,
    touristTaxPct: model?.touristTaxPct ?? null,
    estimatedCommissions: confirmed.filter((r) => r.commissionEstimated).length, unknownCommissions: confirmed.filter((r) => r.commissionCents === null).length, unknownChannel: confirmed.filter((r) => r.channel === "INCONNU").length,
    undeclaredRates: [...new Set(confirmed.filter((r) => r.commissionCents === null && r.channel !== "INCONNU").map((r) => r.channel))],
    marketDays: mk.market.filter((m) => m.marketOccupancy !== null).length, marketCategory: mk.category, marketListings: mk.listingsUsed, marketSource: mk.source, marketError,
    listingChanges: drift, gridRefreshedAt: priceItem.last_refreshed_at ?? listing.lastRefreshedAt, currency: priceItem.currency ?? listing.currency, pushEnabled: listing.pushEnabled,
  };

  let rec: ReconcileResult | null = null;
  await withTenant(tenantId, async (tx) => {
    await lockProperty(tx, p.id); // même ordre de verrous que les webhooks : verrou du logement d'abord, puis calendrier
    await tx.delete(calendarDays).where(eq(calendarDays.propertyId, p.id));
    await tx.delete(marketDays).where(eq(marketDays.propertyId, p.id));
    await tx.insert(calendarDays).values(days.map((d) => ({ propertyId: p.id, tenantId, date: d.date, priceCents: d.priceCents, recommendedPriceCents: d.recommendedPriceCents, sentPriceCents: d.sentPriceCents, minStay: d.minStay, state: d.state, rule: null, observedAt: now })));
    await tx.insert(marketDays).values(mk.market.map((m) => ({ propertyId: p.id, tenantId, ...m, observedAt: now })));
    if (toWrite && source === "SUPERHOTE" && sh?.ok) {
      rec = await reconcileReservations(tx, { tenantId, propertyId: p.id, model, reservations: sh.reservations, readAt: new Date(sh.at) });
      // le calendrier reflète les réservations réellement enregistrées (webhook plus récent, doublon, lecture suspecte), pas seulement la lecture brute
      await applyCalendarEffect(tx, p.id, { from: todayISO(now), to: addDays(todayISO(now), 91) }, [], todayISO(now));
    }
    else if (toWrite) await replaceReservations(tx, tenantId, p.id, toWrite, source);
    await tx.update(properties).set({ bedrooms: p.bedrooms ?? (listing.bedrooms === null ? null : Math.round(listing.bedrooms)), pricelabs: { ...pl, listingName: listing.name, candidates, lastSync }, ...(shLastSync ? { superhote: { ...p.superhote, lastSync: shLastSync, ...(rec ? { lastReconcile: rec } : {}) } } : {}) }).where(eq(properties.id, p.id));
    if (drift.length) await recordAudit(tx, { tenantId, actor: "system", type: "integration.pricelabs_listing_changed", entity: "Property", entityId: p.id, summary: `L'annonce PriceLabs de ${p.name} a changé : ${drift.join(" ; ")}. Vérifiez le mapping.`, payload: { changes: drift } });
    // les prix de base, minimum et maximum suivent PriceLabs : un changement de stratégie est une version, tracée avec son avant/après (US-023)
    const res = await commitStrategy(tx, { tenantId, propertyId: p.id, next: (cur) => ({ ...cur, basePriceCents: listing.baseCents ?? cur.basePriceCents ?? null, minPriceCents: listing.minCents ?? cur.minPriceCents ?? null, maxPriceCents: listing.maxCents ?? cur.maxPriceCents ?? null, maxDiscountStackPct: cur.maxDiscountStackPct ?? 20, maxPriceChangePct: cur.maxPriceChangePct ?? 5 }), source: "PRICELABS_SYNC", createdBy: "system" });
    if (res) {
      const cents = (s: Strategy) => ({ basePriceCents: s.basePriceCents ?? null, minPriceCents: s.minPriceCents ?? null, maxPriceCents: s.maxPriceCents ?? null });
      await recordAudit(tx, { tenantId, actor: "system", type: "property.strategy_synced", entity: "Property", entityId: p.id, summary: `Prix de base, minimum ou maximum de ${p.name} relus depuis PriceLabs (stratégie version ${res.version}).`, payload: { from: cents(res.previous), to: cents(res.strategy), strategyVersion: res.version } });
    }
  });
  await db.insert(agentRuns).values({ id: newId("run"), tenantId, agentId: "onboarding", operation: "syncPriceLabs", mode: "DETERMINISTIC", summary: `${p.name} : PriceLabs lu — ${days.length} jours de grille, ${confirmed.length} réservations${lastSync.duplicates ? ` (${lastSync.duplicates} doublon${lastSync.duplicates > 1 ? "s" : ""} écarté${lastSync.duplicates > 1 ? "s" : ""})` : ""}, marché sur ${lastSync.marketDays} jours${marketError ? " (marché indisponible : " + marketError + ")" : ""}${lastSync.estimatedCommissions ? `, ${lastSync.estimatedCommissions} commissions estimées au taux déclaré` : ""}${shLastSync?.ok ? `, SuperHote lu (${(shLastSync as any).autoChannels} canaux relevés)` : shLastSync ? ` ; SuperHote non lu : ${(shLastSync as any).error}` : ""}.` });
  return { days: days.length, reservations: confirmed.length };
}

/**
 * Test de connexion : lit un petit échantillon (annonces, 7 jours de prix, marché, 60 jours de réservations) pour dire ce que la clé permet de lire.
 * Ne modifie ni la grille, ni le marché, ni les réservations ; seul le résultat du test est mémorisé (`pricelabs.lastCheck`).
 */
export async function testPriceLabsConnection(tenantId: string, propertyId: string, actor: string): Promise<ConnectionReport> {
  const p = await getProp(tenantId, propertyId);
  const pl = p.pricelabs;
  if (!pl?.apiKeyEnc) throw new SyncError("Aucune clé PriceLabs sur ce logement.");
  let apiKey: string;
  try { apiKey = decryptSecret(pl.apiKeyEnc); } catch { throw new SyncError("La clé enregistrée est illisible (APP_SECRET a changé ?). Saisissez-la de nouveau."); }
  const now = new Date();
  const report = await runConnectionCheck(priceLabsFor(apiKey), pl.listingId && pl.pms ? { listingId: pl.listingId, pms: pl.pms } : null, now, todayISO(now));
  // Écriture ciblée et conditionnelle : si la clé a été supprimée ou remplacée pendant le test, on ne ressuscite rien et on ne mémorise rien.
  const saved = await db.transaction(async (tx) => {
    const rows = await tx.update(properties).set({ pricelabs: sql`jsonb_set(${properties.pricelabs}, '{lastCheck}', ${JSON.stringify(report)}::jsonb)` })
      .where(and(eq(properties.id, p.id), sql`${properties.pricelabs}->>'apiKeyEnc' = ${pl.apiKeyEnc}`)).returning({ id: properties.id });
    if (!rows.length) return false;
    await auditTest(tx);
    return true;
  });
  if (!saved) throw new SyncError("La connexion a changé pendant le test : relancez-le.");
  return report;
  async function auditTest(tx: typeof db) {
  const bad = report.checks.filter((c) => c.status === "FAIL" || c.status === "WARN").length;
  await recordAudit(tx, { tenantId, actor, type: "integration.pricelabs_tested", entity: "Property", entityId: p.id, summary: `Test de connexion PriceLabs pour ${p.name} : ${report.ok === null ? "clé valide, annonce à rattacher" : report.ok ? "essentiel disponible" : "échec"}${bad ? `, ${bad} point${bad > 1 ? "s" : ""} à vérifier` : ""}.`, payload: { ok: report.ok, capabilities: report.capabilities } });
  }
}

/** Avant une revue lancée à la main : relit PriceLabs si la dernière lecture a plus de trois heures. */
export async function syncIfStale(tenantId: string, p: typeof properties.$inferSelect): Promise<void> {
  if (p.isDemo) return;
  if (!p.pricelabs?.listingId) {
    // SuperHote seul : les réservations sont relues sur le même rythme
    const sh = p.superhote;
    if (!sh?.rentalId || (sh.lastSync?.ok && Date.now() - +new Date(sh.lastSync.at ?? 0) < 3 * 3600000)) return;
    try { await (await import("./superhote-sync")).syncSuperhote(tenantId, p.id); } catch { /* consigné dans la dernière lecture */ }
    return;
  }
  const at = p.pricelabs.lastSync?.at ? +new Date(p.pricelabs.lastSync.at) : 0;
  if (Date.now() - at < 3 * 3600000 && p.pricelabs.lastSync?.ok) return;
  try { await syncPriceLabs(tenantId, p.id); } catch { /* consigné par syncPriceLabs ; la revue continue sur les données précédentes */ }
}

/** Le propriétaire précise le canal de réservations transmises sans canal par le PMS, ou les écarte du calcul. Mémorisé d'une lecture à l'autre. */
export async function setChannelOverrides(tenantId: string, propertyId: string, choices: Record<string, string>, actor: string): Promise<number> {
  const p = await getProp(tenantId, propertyId);
  if (!p.pricelabs?.listingId) throw new SyncError("Aucune annonce PriceLabs n'est rattachée à ce logement.");
  const overrides: Record<string, ChannelOverride> = {};
  for (const [id, v] of Object.entries(choices)) if (["AIRBNB", "BOOKING", "DIRECT", "EXCLUDE"].includes(v)) overrides[id] = v as ChannelOverride;
  await db.update(properties).set({ pricelabs: { ...p.pricelabs, overrides } }).where(eq(properties.id, p.id));
  const n = Object.keys(overrides).length;
  await recordAudit(db, { tenantId, actor, type: "reservations.channel_overrides", entity: "Property", entityId: p.id, summary: `Canal précisé à la main pour ${n} réservation${n > 1 ? "s" : ""} de ${p.name} transmise${n > 1 ? "s" : ""} sans canal.`, payload: overrides });
  await syncPriceLabs(tenantId, p.id);
  return n;
}

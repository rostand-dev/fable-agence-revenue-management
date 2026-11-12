import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { addDays, todayISO } from "../dates";
import type { EconomicModel, Strategy } from "../engine/types";
import { getNeighborhood, getPrices, getReservations, horizon, listListings, PriceLabsError } from "../integrations/pricelabs";
import { mapMarket, mapPrices, mapReservations } from "../integrations/pricelabs-map";
import { decryptSecret, encryptSecret, secretHint } from "../secret";

const { properties, calendarDays, marketDays, reservations, agentRuns, auditEvents } = schema;
export class SyncError extends Error {}

async function getProp(tenantId: string, id: string) {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, id), eq(properties.tenantId, tenantId)));
  if (!p) throw new SyncError("Logement introuvable.");
  if (p.isDemo) throw new SyncError("Un logement de démonstration ne se connecte pas à PriceLabs.");
  return p;
}
const wrap = (e: unknown) => (e instanceof PriceLabsError || e instanceof SyncError ? e.message : e instanceof Error && e.message.startsWith("APP_SECRET") ? e.message : "Erreur technique pendant la lecture PriceLabs.");

/** Enregistre la clé (chiffrée) après l'avoir vérifiée auprès de PriceLabs. Une seule annonce sur le compte : elle est rattachée d'office. */
export async function connectPriceLabs(tenantId: string, propertyId: string, apiKeyRaw: string, actor: string): Promise<{ listings: number; synced: boolean }> {
  const p = await getProp(tenantId, propertyId);
  const apiKey = apiKeyRaw.trim();
  if (apiKey.length < 20 || /\s/.test(apiKey)) throw new SyncError("Cette clé ne ressemble pas à une clé API PriceLabs. Copiez-la en entier depuis PriceLabs.");
  let listings;
  try { listings = await listListings(apiKey); } catch (e) { throw new SyncError(wrap(e)); }
  if (listings.length === 0) throw new SyncError("La clé est valide, mais ce compte PriceLabs ne contient aucune annonce.");
  const one = listings.length === 1 ? listings[0] : null;
  await db.update(properties).set({
    pricelabs: { apiKeyEnc: encryptSecret(apiKey), keyHint: secretHint(apiKey), connectedAt: new Date().toISOString(), candidates: listings.map((l) => ({ id: l.id, pms: l.pms, name: l.name, city: l.city })), listingId: one?.id ?? null, pms: one?.pms ?? null, listingName: one?.name ?? null },
  }).where(eq(properties.id, p.id));
  await db.insert(auditEvents).values({ id: newId("evt"), tenantId, actor, type: "integration.pricelabs_connected", entity: "Property", entityId: p.id, summary: `Clé API PriceLabs enregistrée pour ${p.name} (${secretHint(apiKey)}), ${listings.length} annonce${listings.length > 1 ? "s" : ""} sur le compte.` });
  if (!one) return { listings: listings.length, synced: false };
  await syncPriceLabs(tenantId, p.id);
  return { listings: 1, synced: true };
}

export async function selectListing(tenantId: string, propertyId: string, listingId: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  const c = (p.pricelabs?.candidates ?? []).find((x: any) => x.id === listingId);
  if (!p.pricelabs?.apiKeyEnc || !c) throw new SyncError("Annonce inconnue pour cette clé.");
  await db.update(properties).set({ pricelabs: { ...p.pricelabs, listingId: c.id, pms: c.pms, listingName: c.name } }).where(eq(properties.id, p.id));
  await syncPriceLabs(tenantId, p.id);
}

export async function disconnectPriceLabs(tenantId: string, propertyId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  await db.update(properties).set({ pricelabs: null }).where(eq(properties.id, p.id));
  await db.insert(auditEvents).values({ id: newId("evt"), tenantId, actor, type: "integration.pricelabs_disconnected", entity: "Property", entityId: p.id, summary: `Clé API PriceLabs supprimée pour ${p.name}. Les données déjà lues sont conservées.` });
}

/**
 * Lecture PriceLabs d'un logement : grille J+0 à J+90, marché, réservations relayées par le PMS, réglages de prix.
 * Lecture seule. En cas d'échec, les données précédentes sont conservées et l'erreur est consignée.
 */
export async function syncPriceLabs(tenantId: string, propertyId: string): Promise<{ days: number; reservations: number }> {
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

  let listing, priceItem, resaRows, market: any = null, marketError: string | null = null;
  try {
    listing = (await listListings(apiKey)).find((l) => l.id === pl.listingId && l.pms === pl.pms);
    if (!listing) throw new PriceLabsError("L'annonce rattachée n'existe plus sur ce compte PriceLabs.");
    priceItem = await getPrices(apiKey, pl.listingId, pl.pms, h.from, h.to);
    resaRows = await getReservations(apiKey, pl.listingId, pl.pms, h.histFrom, h.histTo);
  } catch (e) { throw await fail(wrap(e)); }
  // le marché est utile mais pas bloquant : sans lui, les signaux de rythme restent « inconnus »
  try { market = await getNeighborhood(apiKey, pl.listingId, pl.pms); } catch (e) { marketError = wrap(e); }

  const model = p.economics as EconomicModel;
  const resas = mapReservations(resaRows, model);
  let days = mapPrices(priceItem).filter((d) => d.date >= h.from && d.date <= h.to);
  if (days.length === 0) throw await fail("PriceLabs n'a renvoyé aucun prix sur les 90 prochains jours.");
  // une réservation confirmée à 0 € est un blocage propriétaire : ces nuits sortent du disponible
  const blocked = new Set<string>();
  for (const r of resas) if (r.status === "BLOCKED") for (let d = r.checkIn; d < r.checkOut; d = addDays(d, 1)) blocked.add(d);
  days = days.map((d) => (blocked.has(d.date) ? { ...d, state: "BLOCKED" as const, priceCents: null } : d));
  const bedrooms = p.bedrooms ?? listing.bedrooms;
  const mk = mapMarket(market, bedrooms, days);

  const strat = p.strategy as Strategy;
  const strategy: Strategy = { ...strat, basePriceCents: listing.baseCents ?? strat.basePriceCents ?? null, minPriceCents: listing.minCents ?? strat.minPriceCents ?? null, maxPriceCents: listing.maxCents ?? strat.maxPriceCents ?? null, maxDiscountStackPct: strat.maxDiscountStackPct ?? 20, maxPriceChangePct: strat.maxPriceChangePct ?? 5 };
  const changed = strategy.basePriceCents !== strat.basePriceCents || strategy.minPriceCents !== strat.minPriceCents || strategy.maxPriceCents !== strat.maxPriceCents;
  const confirmed = resas.filter((r) => r.status === "CONFIRMED");
  const lastSync = {
    ok: true, at: now.toISOString(), days: days.length, unknownPrices: days.filter((d) => d.state === "FREE" && d.priceCents === null).length,
    reservations: confirmed.length, cancelled: resas.filter((r) => r.status === "CANCELLED").length, ownerBlocks: resas.filter((r) => r.status === "BLOCKED").length,
    estimatedCommissions: confirmed.filter((r) => r.commissionEstimated).length, unknownCommissions: confirmed.filter((r) => r.commissionCents === null).length,
    marketDays: mk.market.filter((m) => m.marketOccupancy !== null).length, marketCategory: mk.category, marketListings: mk.listingsUsed, marketSource: mk.source, marketError,
    gridRefreshedAt: priceItem.last_refreshed_at ?? listing.lastRefreshedAt, currency: priceItem.currency ?? listing.currency, pushEnabled: listing.pushEnabled,
  };

  await db.transaction(async (tx) => {
    await tx.delete(calendarDays).where(eq(calendarDays.propertyId, p.id));
    await tx.delete(marketDays).where(eq(marketDays.propertyId, p.id));
    await tx.delete(reservations).where(and(eq(reservations.propertyId, p.id), eq(reservations.source, "PRICELABS")));
    await tx.insert(calendarDays).values(days.map((d) => ({ propertyId: p.id, tenantId, date: d.date, priceCents: d.priceCents, minStay: d.minStay, state: d.state, rule: null, observedAt: now })));
    await tx.insert(marketDays).values(mk.market.map((m) => ({ propertyId: p.id, tenantId, ...m, observedAt: now })));
    for (let i = 0; i < resas.length; i += 200) await tx.insert(reservations).values(resas.slice(i, i + 200).map(({ commissionEstimated, ...r }) => ({ id: newId("res"), tenantId, propertyId: p.id, ...r, source: "PRICELABS" }))).onConflictDoNothing();
    await tx.update(properties).set({ strategy, strategyVersion: changed ? p.strategyVersion + 1 : p.strategyVersion, bedrooms: p.bedrooms ?? (listing.bedrooms === null ? null : Math.round(listing.bedrooms)), pricelabs: { ...pl, listingName: listing.name, lastSync } }).where(eq(properties.id, p.id));
  });
  await db.insert(agentRuns).values({ id: newId("run"), tenantId, agentId: "onboarding", operation: "syncPriceLabs", mode: "DETERMINISTIC", summary: `${p.name} : PriceLabs lu — ${days.length} jours de grille, ${confirmed.length} réservations, marché sur ${lastSync.marketDays} jours${marketError ? " (marché indisponible : " + marketError + ")" : ""}${lastSync.estimatedCommissions ? `, ${lastSync.estimatedCommissions} commissions estimées au taux déclaré` : ""}.` });
  return { days: days.length, reservations: confirmed.length };
}

/** Avant la revue quotidienne : relit PriceLabs si la dernière lecture a plus de trois heures. */
export async function syncIfStale(tenantId: string, p: typeof properties.$inferSelect): Promise<void> {
  if (p.isDemo || !p.pricelabs?.listingId) return;
  const at = p.pricelabs.lastSync?.at ? +new Date(p.pricelabs.lastSync.at) : 0;
  if (Date.now() - at < 3 * 3600000 && p.pricelabs.lastSync?.ok) return;
  try { await syncPriceLabs(tenantId, p.id); } catch { /* consigné par syncPriceLabs ; la revue continue sur les données précédentes */ }
}

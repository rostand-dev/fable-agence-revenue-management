import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayISO, type ISODate } from "@/lib/dates";
import { missingEconomics } from "@/lib/engine/economics";
import { simulate, type SimPromo, type Simulation } from "@/lib/engine/simulator";
import { CHANNELS, type Channel, type EconomicModel, type Strategy } from "@/lib/engine/types";
import { promoKind } from "@/lib/stacking/rules";
import { PortfolioError } from "./portfolio";

const { properties, promotions } = schema;
const STALE_MS = 7 * 86_400_000;
const isDate = (s: string) => /^20\d{2}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const intIn = (raw: string | null, lo: number, hi: number) => (raw !== null && /^\d+$/.test(raw) && Number(raw) >= lo && Number(raw) <= hi ? Number(raw) : null);
const pctIn = (raw: string) => (/^\d+([.,]\d+)?$/.test(raw) && Number(raw.replace(",", ".")) > 0 && Number(raw.replace(",", ".")) < 100 ? Number(raw.replace(",", ".")) : null);

export type SimQuery = { channel: Channel; nights: number; from: ISODate; publishedNightlyCents: number; losDiscountPct?: number; promos: SimPromo[] };

/**
 * Lit les paramètres de requête : `channel`, `nights` (1 à 90), `from` (date, défaut aujourd'hui), `price` (centimes : prix publié par nuit SUR le canal,
 * majoration comprise), `los` (remise de durée, en %), `promo` répétable au format `TYPE:pourcentage` (par exemple `GENIUS:10`).
 */
export function parseSimQuery(sp: URLSearchParams, today: ISODate): SimQuery {
  const bad = (m: string) => { throw new PortfolioError("INVALID", m); };
  const channel = sp.get("channel") as Channel | null;
  if (!channel || !CHANNELS.includes(channel)) bad("channel : AIRBNB ou BOOKING.");
  const nights = intIn(sp.get("nights"), 1, 90); if (nights === null) bad("nights : un nombre entier de nuits entre 1 et 90.");
  const price = intIn(sp.get("price"), 1, 10_000_000); if (price === null) bad("price : le prix publié par nuit sur le canal, en centimes (entier positif).");
  const from = sp.get("from") ?? today; if (!isDate(from)) bad("from : une date AAAA-MM-JJ.");
  const farDays = (Date.parse(from + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000;
  if (farDays < -400 || farDays > 1100) bad("from : une date entre un an avant et trois ans après aujourd'hui.");
  let los: number | undefined;
  if (sp.has("los")) { const v = pctIn(sp.get("los")!); if (v === null) bad("los : un pourcentage strictement entre 0 et 100."); los = v!; if (channel === "BOOKING") bad("los : la remise de durée de séjour n'est documentée que pour Airbnb ; sur Booking.com, saisissez la promotion voulue avec promo."); }
  const promoRaw = sp.getAll("promo");
  if (promoRaw.length > 6) bad("promo : six promotions au plus.");
  const promos = promoRaw.map((r) => {
    const m = /^([A-Za-z_]{2,24}):(.+)$/.exec(r);
    const v = m ? pctIn(m[2]) : null;
    if (!m || v === null) return bad("promo : le format TYPE:pourcentage (par exemple GENIUS:10), pourcentage strictement entre 0 et 100.");
    const kind = m[1].toUpperCase();
    if (kind === "LOS") return bad("promo : la remise de durée de séjour se donne avec le paramètre los.");
    return { kind, label: promoKind(channel!, kind)?.label ?? kind, discountPct: v! };
  });
  return { channel: channel!, nights: nights!, from, publishedNightlyCents: price!, losDiscountPct: los, promos: promos as SimPromo[] };
}

export type SimulationView = Simulation & { propertyId: string; input: SimQuery; maxDiscountStackPct: number; registryStale: boolean };

/** Simulation explicable d'un séjour sur un logement : lecture seule, isolée par locataire, rien n'est enregistré. */
export async function simulateForProperty(tenantId: string, propertyId: string, sp: URLSearchParams, now = new Date()): Promise<SimulationView> {
  const [p] = await db.select({ id: properties.id, economics: properties.economics, strategy: properties.strategy }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  const q = parseSimQuery(sp, todayISO(now));
  const model = p.economics as EconomicModel;
  const miss = missingEconomics(model, q.channel);
  if (miss.length) throw new PortfolioError("INVALID", `Simulation impossible : il manque ${miss.join(", ")}.`);
  const max = (p.strategy as Strategy | null)?.maxDiscountStackPct;
  if (typeof max !== "number" || !Number.isFinite(max)) throw new PortfolioError("INVALID", "Simulation impossible : le plafond de cumul des remises de la stratégie est inconnu.");
  // même règle que la détection : un registre dont une promotion du canal n'a pas été vérifiée depuis plus de 7 jours (ou jamais) est incertain
  const reg = await db.select({ verifiedAt: promotions.verifiedAt }).from(promotions).where(and(eq(promotions.tenantId, tenantId), eq(promotions.propertyId, propertyId), eq(promotions.channel, q.channel), eq(promotions.status, "ACTIVE")));
  const registryStale = reg.length > 0 && reg.some((r) => !r.verifiedAt || +now - +r.verifiedAt > STALE_MS);
  const sim = simulate({ model, channel: q.channel, nights: q.nights, stayFrom: q.from, publishedNightlyCents: q.publishedNightlyCents, losDiscountPct: q.losDiscountPct, promos: q.promos, maxDiscountStackPct: max, registryStale });
  return { ...sim, propertyId, input: q, maxDiscountStackPct: max, registryStale };
}

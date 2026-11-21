import { addDays, type ISODate } from "../dates";
import { lastPage, listOf, mapCalendar, mapRental, mapReservation, unwrap, type ShNight, type ShRental, type ShReservation } from "./superhote-map";

/** Client de l'API publique SuperHote v2 : lecture (scopes rentals.read, calendar.read, reservations.read) et gestion des webhooks sortants (scope public-api:webhooks.manage). Aucune écriture sur les réservations ni les prix. */
export class SuperhoteError extends Error {
  constructor(message: string, public status: number | null = null) { super(message); }
}
const base = () => (process.env.SUPERHOTE_API_BASE || "https://connect.superhote.com/api/v2/public").replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(token: string, path: string, retried = false, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}): Promise<any> {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(base() + path, { method: init.method ?? "GET", signal: ctrl.signal, cache: "no-store", redirect: init.method === "POST" || init.method === "DELETE" ? "error" : "follow", body: init.body === undefined ? undefined : JSON.stringify(init.body), headers: { Authorization: `Bearer ${token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) } });
  } catch (e: any) {
    throw new SuperhoteError(e?.name === "AbortError" ? "SuperHote n'a pas répondu à temps." : "SuperHote est injoignable depuis le serveur.");
  } finally { clearTimeout(timer); }
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get("Retry-After"));
    if (Number.isFinite(wait) && wait > 0 && wait <= 20) { await sleep(wait * 1000); return call(token, path, true, init); }
  }
  if (res.status === 401) throw new SuperhoteError("Jeton refusé par SuperHote. Vérifiez qu'il est copié en entier et qu'il n'a pas été révoqué (Plateformes → API).", 401);
  if (res.status === 403) throw new SuperhoteError("Accès refusé par SuperHote : ce jeton n'a pas les droits de lecture nécessaires.", 403);
  if (res.status === 422 && init.method === "POST") {
    let detail = ""; try { detail = String((await res.json())?.message ?? ""); } catch { /* corps absent */ }
    throw new SuperhoteError(`SuperHote a refusé la demande (${detail.slice(0, 160) || "422"}). Causes fréquentes : adresse du webhook non publique ou non valide, ou limite de 10 webhooks par compte atteinte.`, 422);
  }
  if (res.status === 404) throw new SuperhoteError("SuperHote ne trouve pas cette ressource. Hors du périmètre du jeton, l'API répond 404 : vérifiez ses droits (rentals.read, calendar.read, reservations.read).", 404);
  if (res.status === 429) throw new SuperhoteError("Trop de requêtes vers SuperHote (limite de 120 par minute). Réessayez dans quelques minutes.", 429);
  if (!res.ok) throw new SuperhoteError(`SuperHote a répondu par une erreur (HTTP ${res.status}).`, res.status);
  if (init.method === "DELETE") return null; // la doc ne précise pas le corps d'une suppression réussie
  let j: any;
  try { j = await res.json(); } catch { throw new SuperhoteError("Réponse SuperHote illisible."); }
  if (j && j.success === false) throw new SuperhoteError(`SuperHote a refusé la requête : ${String(j.message ?? "erreur sans détail").slice(0, 200)}`);
  return j;
}

async function pages(token: string, path: string, max = 30): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= max; page++) {
    const j = await call(token, `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`);
    rows.push(...listOf(unwrap(j)));
    if (page >= lastPage(j)) break;
  }
  return rows;
}

export async function listRentals(token: string): Promise<ShRental[]> {
  return (await pages(token, "/rentals")).map(mapRental).filter((r): r is ShRental => !!r);
}
/** Réservations du compte (la doc ne documente pas de filtre par logement : filtré côté serveur NuitSignal). */
export async function listReservations(token: string, rentalId: string, updatedSince?: string): Promise<ShReservation[]> {
  const q = updatedSince ? `/reservations?updated_since=${encodeURIComponent(updatedSince)}` : "/reservations";
  return (await pages(token, q, 40)).map(mapReservation).filter((r): r is ShReservation => !!r && r.rentalId === rentalId);
}
export async function getCalendar(token: string, rentalId: string, from: ISODate, to: ISODate): Promise<ShNight[]> {
  const j = await call(token, `/rentals/${encodeURIComponent(rentalId)}/calendar?from=${from}&to=${to}`);
  return mapCalendar(listOf(unwrap(j)));
}
export const calendarHorizon = (today: ISODate) => ({ from: today, to: addDays(today, 90) });

/** Abonne l'adresse donnée aux événements de réservation. Le secret de signature n'est renvoyé qu'une fois, ici. */
export async function createWebhook(token: string, url: string, events: string[]): Promise<{ id: string; secret: string }> {
  const j = await call(token, "/webhooks", false, { method: "POST", body: { url, events } });
  const r = unwrap(j) as any, id = r?.webhook?.id, secret = r?.secret;
  if (id === undefined || id === null || typeof secret !== "string" || !secret) {
    if (id !== undefined && id !== null) { try { await deleteWebhook(token, String(id)); } catch { /* retiré à la main chez SuperHote si besoin */ } }
    throw new SuperhoteError("SuperHote n'a pas renvoyé le secret du webhook : l'abonnement a été retiré, réessayez.");
  }
  return { id: String(id), secret };
}
/** Supprime un webhook ; déjà absent (404) = c'est fait. */
export async function deleteWebhook(token: string, remoteId: string): Promise<void> {
  try { await call(token, `/webhooks/${encodeURIComponent(remoteId)}`, false, { method: "DELETE" }); }
  catch (e) { if (e instanceof SuperhoteError && e.status === 404) return; throw e; }
}

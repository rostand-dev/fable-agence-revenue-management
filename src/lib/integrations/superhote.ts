import { addDays, type ISODate } from "../dates";
import { lastPage, listOf, mapCalendar, mapRental, mapReservation, unwrap, type ShNight, type ShRental, type ShReservation } from "./superhote-map";

/** Client de l'API publique SuperHote v2, en LECTURE SEULE (scopes rentals.read, calendar.read, reservations.read). */
export class SuperhoteError extends Error {
  constructor(message: string, public status: number | null = null) { super(message); }
}
const base = () => (process.env.SUPERHOTE_API_BASE || "https://connect.superhote.com/api/v2/public").replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(token: string, path: string, retried = false): Promise<any> {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(base() + path, { method: "GET", signal: ctrl.signal, cache: "no-store", headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
  } catch (e: any) {
    throw new SuperhoteError(e?.name === "AbortError" ? "SuperHote n'a pas répondu à temps." : "SuperHote est injoignable depuis le serveur.");
  } finally { clearTimeout(timer); }
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get("Retry-After"));
    if (Number.isFinite(wait) && wait > 0 && wait <= 20) { await sleep(wait * 1000); return call(token, path, true); }
  }
  if (res.status === 401) throw new SuperhoteError("Jeton refusé par SuperHote. Vérifiez qu'il est copié en entier et qu'il n'a pas été révoqué (Plateformes → API).", 401);
  if (res.status === 403) throw new SuperhoteError("Accès refusé par SuperHote : ce jeton n'a pas les droits de lecture nécessaires.", 403);
  if (res.status === 404) throw new SuperhoteError("SuperHote ne trouve pas cette ressource. Hors du périmètre du jeton, l'API répond 404 : vérifiez ses droits (rentals.read, calendar.read, reservations.read).", 404);
  if (res.status === 429) throw new SuperhoteError("Trop de requêtes vers SuperHote (limite de 120 par minute). Réessayez dans quelques minutes.", 429);
  if (!res.ok) throw new SuperhoteError(`SuperHote a répondu par une erreur (HTTP ${res.status}).`, res.status);
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

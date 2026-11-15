import { todayISO } from "../dates";
import { calendarHorizon, getCalendar, listReservations, SuperhoteError } from "../integrations/superhote";
import { ShapeError, type ShNight, type ShReservation } from "../integrations/superhote-map";
import { decryptSecret } from "../secret";

/** Lecture SuperHote d'un logement rattaché (lecture seule). Jamais bloquante : une erreur est renvoyée, pas levée. */
export type ShSnapshot = { ok: true; at: string; reservations: ShReservation[]; calendar: ShNight[] } | { ok: false; at: string; error: string };

export const shErrorText = (e: unknown): string =>
  e instanceof SuperhoteError || e instanceof ShapeError ? e.message : e instanceof Error && e.message.startsWith("APP_SECRET") ? e.message : "Erreur technique pendant la lecture SuperHote.";

export async function snapshotSuperhote(sh: Record<string, any> | null | undefined, now = new Date()): Promise<ShSnapshot | null> {
  if (!sh?.apiKeyEnc || !sh.rentalId) return null;
  const at = now.toISOString();
  try {
    const token = decryptSecret(sh.apiKeyEnc), h = calendarHorizon(todayISO(now));
    const reservations = await listReservations(token, String(sh.rentalId));
    const calendar = await getCalendar(token, String(sh.rentalId), h.from, h.to);
    return { ok: true, at, reservations, calendar };
  } catch (e) { return { ok: false, at, error: shErrorText(e) }; }
}

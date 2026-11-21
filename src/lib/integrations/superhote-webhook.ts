/**
 * Réception d'un webhook SuperHote (US-030) : vérification de la signature et lecture de l'enveloppe. Module pur (aucun accès base).
 * Référence : https://docs.superhote.com/api-v2/ — en-têtes `X-Superhote-Signature` (« sha256= » + HMAC-SHA256 du corps BRUT), `X-Superhote-Event`,
 * `X-Superhote-Delivery` (identique à chaque nouvelle tentative : clé d'idempotence).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { pickAllowed } from "../privacy/pii";
import { mapReservation, type ShReservation } from "./superhote-map";

/** Taille maximale acceptée d'un corps : une réservation tient en quelques ko, au-delà c'est un abus. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const RESERVATION_EVENTS = ["reservation.created", "reservation.updated", "reservation.canceled"] as const;
export type ReservationEvent = (typeof RESERVATION_EVENTS)[number];

/** Champs de la réservation conservés dans la boîte de réception. Tout le reste (nom, e-mail, téléphone, nombre de voyageurs…) est écarté à l'entrée (US-034). */
export const RESERVATION_FIELDS = ["id", "rental_id", "status", "status_label", "platform", "platform_name", "checkin", "checkout", "nights", "total_price", "fare_accommodation", "host_payout", "price_details", "host_fees", "currency", "external_id", "booked_at", "canceled_at", "created_at", "updated_at"] as const;

/** Signature attendue pour un corps brut. */
export const sign = (raw: Buffer | string, secret: string): string => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

/** Comparaison à temps constant ; refuse un en-tête absent, mal formé ou de mauvaise longueur. */
export function verifySignature(raw: Buffer, header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const given = header.trim().toLowerCase(), want = sign(raw, secret);
  if (given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

export type ParsedDelivery =
  | { ok: true; kind: "reservation"; event: ReservationEvent; deliveryId: string; occurredAt: string | null; reservation: ShReservation; payload: Record<string, unknown> }
  | { ok: true; kind: "other"; event: string; deliveryId: string }
  | { ok: false; status: 400; reason: string };

/** Lit l'enveloppe (le corps est supposé déjà authentifié). Un événement hors réservation est reconnu mais ignoré. */
export function parseDelivery(raw: Buffer, headers: { event?: string | null; delivery?: string | null }): ParsedDelivery {
  let body: any;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return { ok: false, status: 400, reason: "Corps JSON illisible." }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, reason: "Enveloppe inattendue." };
  // Seul le corps est signé : il fait foi. Les en-têtes (non signés) ne servent qu'à défaut, et un désaccord est refusé (pas de rejeu sous un autre identifiant).
  const pick = (fromBody: unknown, fromHeader: string | null | undefined) => {
    const b = typeof fromBody === "string" ? fromBody.trim() : "", h = (fromHeader ?? "").trim();
    return b && h && b !== h ? ({ conflict: true } as const) : { value: b || h };
  };
  const d = pick(body.delivery_id, headers.delivery), e = pick(body.event, headers.event);
  if ("conflict" in d) return { ok: false, status: 400, reason: "L'identifiant de livraison de l'en-tête diffère de celui du corps signé." };
  if ("conflict" in e) return { ok: false, status: 400, reason: "Le type d'événement de l'en-tête diffère de celui du corps signé." };
  const deliveryId = d.value.slice(0, 121), event = e.value.slice(0, 80);
  if (!deliveryId || deliveryId.length > 120) return { ok: false, status: 400, reason: "Identifiant de livraison absent ou invalide." };
  if (!event) return { ok: false, status: 400, reason: "Type d'événement absent." };
  if (!(RESERVATION_EVENTS as readonly string[]).includes(event)) return { ok: true, kind: "other", event, deliveryId };
  const raw_ = body?.data?.reservation;
  if (!raw_ || typeof raw_ !== "object") return { ok: false, status: 400, reason: "Réservation absente de l'événement." };
  const payload = pickAllowed(raw_, RESERVATION_FIELDS);
  const mapped = mapReservation(payload);
  if (!mapped || !mapped.rentalId) return { ok: false, status: 400, reason: "Réservation incomplète (identifiant, logement ou dates absents)." };
  // reservation.canceled : annulée même si la charge utile ne porte pas encore l'état
  const reservation = event === "reservation.canceled" ? { ...mapped, canceled: true } : mapped;
  return { ok: true, kind: "reservation", event: event as ReservationEvent, deliveryId, occurredAt: typeof body.created_at === "string" ? body.created_at : null, reservation, payload };
}

/** Empreinte (HMAC, clé dérivée de APP_SECRET) d'un jeton API : relie les logements d'un même compte SuperHote sans stocker le jeton. */
export function fingerprintToken(token: string): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error("APP_SECRET manquant sur le serveur : impossible d'enregistrer un webhook de façon sûre.");
  return createHmac("sha256", "webhook-fp:" + s).update(token).digest("hex");
}

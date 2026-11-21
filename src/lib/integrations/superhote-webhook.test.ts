import { describe, expect, it } from "vitest";
import { MAX_WEBHOOK_BYTES, parseDelivery, RESERVATION_FIELDS, sign, verifySignature } from "./superhote-webhook";

const resa = (o: Record<string, unknown> = {}) => ({ id: 501, rental_id: 7, status: 1, status_label: "CONFIRMED", platform_name: "Airbnb", checkin: "2026-12-01", checkout: "2026-12-04", nights: 3, total_price: 300, host_payout: 255, host_fees: [{ type: "host_platform_commission", total: 45 }], price_details: [{ type: "cleaning_fee", total: 50 }], external_id: "HMABC", booked_at: "2026-11-01", updated_at: "2026-11-10T10:00:00+00:00", ...o });
const body = (r: Record<string, unknown>, o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ event: "reservation.created", delivery_id: "d-1", created_at: "2026-11-10T10:00:01+00:00", data: { reservation: r }, ...o }));

describe("signature", () => {
  const raw = Buffer.from('{"a":1}'), secret = "whsec_test";
  it("accepte la signature du corps brut, refuse tout le reste", () => {
    expect(verifySignature(raw, sign(raw, secret), secret)).toBe(true);
    expect(verifySignature(raw, sign(raw, secret).toUpperCase().replace("SHA256=", "sha256="), secret)).toBe(true); // hexadécimal insensible à la casse
    expect(verifySignature(Buffer.from('{"a": 1}'), sign(raw, secret), secret)).toBe(false); // un espace de plus = autre corps
    expect(verifySignature(raw, sign(raw, "autre"), secret)).toBe(false);
    expect(verifySignature(raw, null, secret)).toBe(false);
    expect(verifySignature(raw, "", secret)).toBe(false);
    expect(verifySignature(raw, "sha256=abc", secret)).toBe(false);
    expect(verifySignature(raw, sign(raw, secret), "")).toBe(false);
    expect(verifySignature(raw, sign(raw, secret).slice(7), secret)).toBe(false); // sans préfixe
  });
});

describe("parseDelivery", () => {
  it("lit une réservation créée : identifiants, dates, montants en centimes", () => {
    const p = parseDelivery(body(resa()), { event: "reservation.created", delivery: "d-1" });
    expect(p).toMatchObject({ ok: true, kind: "reservation", event: "reservation.created", deliveryId: "d-1" });
    if (p.ok && p.kind === "reservation") expect(p.reservation).toMatchObject({ id: "501", rentalId: "7", checkIn: "2026-12-01", checkOut: "2026-12-04", totalCents: 30000, canceled: false });
  });
  it("aucune donnée du voyageur n'est conservée, même si l'API en envoyait", () => {
    const p = parseDelivery(body(resa({ guest_first_name: "Camille", guest_last_name: "Durand", guest_email: "camille@example.com", guest_phone: "+33612345678", guests_count: 2, notes: "code 1234" })), { delivery: "d-1" });
    expect(p.ok && p.kind === "reservation").toBe(true);
    if (p.ok && p.kind === "reservation") {
      expect(JSON.stringify(p.payload)).not.toMatch(/Camille|Durand|camille@|\+3361|1234|guest/);
      expect(Object.keys(p.payload).every((k) => (RESERVATION_FIELDS as readonly string[]).includes(k))).toBe(true);
    }
  });
  it("une annulation par l'API arrive en updated avec status_label CANCELED : traitée comme annulée", () => {
    const p = parseDelivery(body(resa({ status_label: "CANCELED" }), { event: "reservation.updated" }), { delivery: "d-1" });
    expect(p.ok && p.kind === "reservation" && p.reservation.canceled).toBe(true);
  });
  it("reservation.canceled force l'annulation même si l'état n'est pas encore à jour dans la charge utile", () => {
    const p = parseDelivery(body(resa(), { event: "reservation.canceled" }), { delivery: "d-1" });
    expect(p.ok && p.kind === "reservation" && p.reservation.canceled).toBe(true);
  });
  it("le corps signé fait foi ; l'en-tête ne sert qu'à défaut, et un désaccord est refusé (pas de rejeu sous un autre identifiant ni d'annulation forcée)", () => {
    expect(parseDelivery(body(resa(), { delivery_id: "corps" }), {})).toMatchObject({ deliveryId: "corps" });
    expect(parseDelivery(body(resa(), { delivery_id: "corps" }), { delivery: "corps" })).toMatchObject({ deliveryId: "corps" });
    expect(parseDelivery(body(resa(), { delivery_id: undefined }), { delivery: "entete", event: "reservation.created" })).toMatchObject({ deliveryId: "entete" });
    expect(parseDelivery(body(resa(), { delivery_id: "corps" }), { delivery: "entete" })).toMatchObject({ ok: false, status: 400, reason: expect.stringContaining("identifiant") });
    expect(parseDelivery(body(resa()), { event: "reservation.canceled", delivery: "d-1" })).toMatchObject({ ok: false, status: 400, reason: expect.stringContaining("événement") });
  });
  it("une réservation sans logement est refusée à l'entrée", () => {
    expect(parseDelivery(body(resa({ rental_id: null })), { delivery: "d-1" })).toMatchObject({ ok: false, status: 400 });
  });
  it("un événement hors réservation est reconnu mais ignoré", () => {
    expect(parseDelivery(Buffer.from(JSON.stringify({ event: "message.received", data: { message: { text: "bonjour" } } })), { event: "message.received", delivery: "d-4" })).toEqual({ ok: true, kind: "other", event: "message.received", deliveryId: "d-4" });
  });
  it("refuse les enveloppes invalides avec une raison", () => {
    const bad = (raw: string | Buffer, h = { event: "reservation.created", delivery: "d" }) => parseDelivery(Buffer.from(raw), h);
    expect(bad("pas du json")).toMatchObject({ ok: false, status: 400 });
    expect(bad("[]")).toMatchObject({ ok: false });
    expect(bad("null")).toMatchObject({ ok: false });
    expect(bad(JSON.stringify({ data: { reservation: resa() } }), { event: "reservation.created", delivery: "" })).toMatchObject({ ok: false, reason: expect.stringContaining("livraison") });
    expect(bad(JSON.stringify({ data: { reservation: resa() } }), { event: "", delivery: "d" })).toMatchObject({ ok: false, reason: expect.stringContaining("événement") });
    expect(bad(JSON.stringify({ data: {} }))).toMatchObject({ ok: false, reason: expect.stringContaining("Réservation absente") });
    expect(bad(JSON.stringify({ data: { reservation: resa({ checkin: null }) } }))).toMatchObject({ ok: false, reason: expect.stringContaining("incomplète") });
    expect(bad(JSON.stringify({ data: { reservation: resa() } }), { event: "reservation.created", delivery: "x".repeat(121) })).toMatchObject({ ok: false });
  });
  it("la taille maximale est bornée", () => { expect(MAX_WEBHOOK_BYTES).toBe(262144); });
});

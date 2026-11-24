import { describe, expect, it } from "vitest";
import { canVerifyManual, cooldownFor, COOLDOWN_DAYS, EXPIRY_REASON, isExpired, ROLLBACK_REASON, type EndedRow } from "./lifecycle";

const T0 = new Date("2026-11-20T10:00:00Z");
describe("seconde relecture", () => {
  it("une autre personne peut vérifier tout de suite", () => expect(canVerifyManual({ executedAt: T0, declaredBy: "u1", actorId: "u2", now: T0 })).toEqual({ ok: true, by: "OTHER_PERSON" }));
  it("la même personne : refus avant 24 h, accord ensuite", () => {
    expect(canVerifyManual({ executedAt: T0, declaredBy: "u1", actorId: "u1", now: new Date("2026-11-21T09:59:00Z") }).ok).toBe(false);
    expect(canVerifyManual({ executedAt: T0, declaredBy: "u1", actorId: "u1", now: new Date("2026-11-21T10:00:00Z") })).toEqual({ ok: true, by: "LATER_REREAD" });
  });
  it("sans trace de l'auteur : seul le délai compte", () => {
    expect(canVerifyManual({ executedAt: T0, declaredBy: null, actorId: "u2", now: new Date("2026-11-20T11:00:00Z") }).ok).toBe(false);
    expect(canVerifyManual({ executedAt: T0, declaredBy: null, actorId: "u2", now: new Date("2026-11-22T11:00:00Z") }).ok).toBe(true);
  });
  it("sans date d'exécution : refus lisible", () => expect(canVerifyManual({ executedAt: null, declaredBy: "u1", actorId: "u1", now: T0 }).ok).toBe(false));
});

const ended = (over: Partial<EndedRow> = {}): EndedRow => ({ channel: "BOOKING", kind: "MOBILE", listingId: null, status: "ENDED", endedAt: new Date("2026-11-22T08:00:00Z"), endReason: "Arrêtée par le propriétaire", label: "Tarif mobile", ...over });
describe("période de repos", () => {
  const c = { channel: "BOOKING", kind: "MOBILE" };
  it(`${COOLDOWN_DAYS} jours après une fin manuelle, même canal et même type`, () => {
    expect(cooldownFor([ended()], c, "2026-11-24")).toEqual({ until: "2026-11-29", label: "Tarif mobile" });
    expect(cooldownFor([ended()], c, "2026-11-29")).toBeNull();
  });
  it("autre canal, autre type, autre annonce : aucun repos", () => {
    expect(cooldownFor([ended()], { channel: "AIRBNB", kind: "MOBILE" }, "2026-11-24")).toBeNull();
    expect(cooldownFor([ended()], { channel: "BOOKING", kind: "COUNTRY" }, "2026-11-24")).toBeNull();
    expect(cooldownFor([ended({ listingId: "l1" })], { ...c, listingId: "l2" }, "2026-11-24")).toBeNull();
    expect(cooldownFor([ended({ listingId: "l1" })], { ...c, listingId: "l1" }, "2026-11-24")).not.toBeNull();
  });
  it("une expiration naturelle ou une promotion encore active n'ouvre aucun repos ; la fin la plus tardive l'emporte", () => {
    expect(cooldownFor([ended({ endReason: EXPIRY_REASON })], c, "2026-11-24")).toBeNull();
    expect(cooldownFor([ended({ status: "ACTIVE" })], c, "2026-11-24")).toBeNull();
    expect(cooldownFor([ended(), ended({ endedAt: new Date("2026-11-23T08:00:00Z"), label: "Plus récente" })], c, "2026-11-24")?.label).toBe("Plus récente");
  });
});
describe("période de repos : jour de Paris et retour arrière", () => {
  const c = { channel: "BOOKING", kind: "MOBILE" };
  it("une fin à 00:30 Paris (22:30 UTC la veille) compte pour le jour de Paris", () => {
    const r = ended({ endedAt: new Date("2026-11-21T23:30:00Z") }); // 22/11 00:30 à Paris
    expect(cooldownFor([r], c, "2026-11-28")).toEqual({ until: "2026-11-29", label: "Tarif mobile" });
    expect(cooldownFor([r], c, "2026-11-29")).toBeNull();
  });
  it("un retour arrière n'ouvre aucun repos", () => expect(cooldownFor([ended({ endReason: ROLLBACK_REASON })], c, "2026-11-24")).toBeNull());
  it("seconde relecture pile à 24 h", () => expect(canVerifyManual({ executedAt: T0, declaredBy: "u1", actorId: "u1", now: new Date(+T0 + 24 * 3_600_000) }).ok).toBe(true));
});
describe("expiration", () => {
  it("séjours passés (fin exclue) ; permanente jamais ; terminée déjà", () => {
    expect(isExpired({ status: "ACTIVE", stayTo: "2026-11-24" }, "2026-11-24")).toBe(true);
    expect(isExpired({ status: "PLANNED", stayTo: "2026-11-20" }, "2026-11-24")).toBe(true);
    expect(isExpired({ status: "ACTIVE", stayTo: "2026-11-25" }, "2026-11-24")).toBe(false);
    expect(isExpired({ status: "ACTIVE", stayTo: null }, "2026-11-24")).toBe(false);
    expect(isExpired({ status: "ENDED", stayTo: "2026-11-01" }, "2026-11-24")).toBe(false);
  });
});

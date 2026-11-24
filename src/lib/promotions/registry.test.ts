import { describe, expect, it } from "vitest";
import { audienceOfKind, findDuplicate, promotionView, unknownStacking, validatePromotion, VERIFY_MAX_AGE_DAYS, type RegistryRow } from "./registry";

const TODAY = "2026-11-24";
const ok = (raw: Record<string, unknown>) => { const r = validatePromotion(raw, TODAY); if (!r.ok) throw new Error(r.error); return r.value; };
const bad = (raw: Record<string, unknown>) => { const r = validatePromotion(raw, TODAY); if (r.ok) throw new Error("aurait dû être refusée"); return r.error; };
const BASE = { channel: "BOOKING", kind: "MOBILE", discountPct: "10" };
const row = (o: Partial<RegistryRow> & { id: string }): RegistryRow => ({ channel: "BOOKING", kind: "MOBILE", label: "Mobile", discountPct: 10, status: "ACTIVE", stayFrom: null, stayTo: null, listingId: null, verifiedAt: null, ...o });

describe("validation d'une promotion (US-100)", () => {
  it("accepte une saisie minimale et reprend le libellé du type, l'audience est déduite du type", () => {
    const v = ok(BASE);
    expect(v).toMatchObject({ channel: "BOOKING", kind: "MOBILE", label: "Tarif mobile", discountPct: 10, audience: "MOBILE", stayFrom: null, stayTo: null, bookFrom: null, minLos: null, listingId: null, externalRef: null });
    expect(audienceOfKind("GENIUS")).toBe("MEMBERS");
    expect(audienceOfKind("COUNTRY")).toBe("COUNTRY");
    expect(audienceOfKind("LOS")).toBe("ALL");
  });
  it("accepte la virgule décimale, arrondit à un chiffre et normalise les espaces du libellé", () => {
    const v = ok({ ...BASE, discountPct: "12,55", label: "  Offre   d'automne " });
    expect(v.label).toBe("Offre d'automne");
    expect(v.discountPct).toBeCloseTo(12.6, 5);
    expect(ok({ ...BASE, discountPct: "12,5" }).discountPct).toBe(12.5);
  });
  it("refuse un canal, un type ou un couple canal/type inconnu", () => {
    expect(bad({ ...BASE, channel: "VRBO" })).toMatch(/canal/);
    expect(bad({ ...BASE, kind: "NOPE" })).toMatch(/type de promotion connu/);
    expect(bad({ ...BASE, channel: "AIRBNB", kind: "MOBILE" })).toMatch(/type de promotion connu/);
  });
  it("refuse une remise absente, nulle, hors bornes ou non numérique ; jamais zéro par défaut", () => {
    for (const d of ["", "0", "-5", "81", "abc", "NaN", "Infinity"]) expect(bad({ ...BASE, discountPct: d }), d).toMatch(/pourcentage entre 1 et 80/);
    expect(ok({ ...BASE, discountPct: "80" }).discountPct).toBe(80);
    expect(ok({ ...BASE, discountPct: "1" }).discountPct).toBe(1);
  });
  it("les dates de séjour vont par paire, dans l'ordre, et pas dans le passé", () => {
    expect(bad({ ...BASE, stayFrom: "2026-12-01" })).toMatch(/les deux dates de séjour/);
    expect(bad({ ...BASE, stayTo: "2026-12-01" })).toMatch(/les deux dates de séjour/);
    expect(bad({ ...BASE, stayFrom: "2026-12-10", stayTo: "2026-12-10" })).toMatch(/après leur début/);
    expect(bad({ ...BASE, stayFrom: "2026-12-10", stayTo: "2026-12-01" })).toMatch(/après leur début/);
    expect(bad({ ...BASE, stayFrom: "2026-10-01", stayTo: "2026-11-24" })).toMatch(/déjà passés/);
    expect(bad({ ...BASE, stayFrom: "2026-02-30", stayTo: "2026-12-01" })).toMatch(/n'est pas valide/);
    expect(bad({ ...BASE, stayFrom: "2029-01-01", stayTo: "2029-02-01" })).toMatch(/deux ans/);
    expect(ok({ ...BASE, stayFrom: "2026-11-01", stayTo: "2026-11-25" })).toMatchObject({ stayFrom: "2026-11-01", stayTo: "2026-11-25" });
  });
  it("la fenêtre de réservation va par paire ; la fin peut tomber le même jour que le début", () => {
    expect(bad({ ...BASE, bookFrom: "2026-12-01" })).toMatch(/les deux dates de réservation/);
    expect(bad({ ...BASE, bookFrom: "2026-12-05", bookTo: "2026-12-01" })).toMatch(/même jour ou après/);
    expect(ok({ ...BASE, bookFrom: "2026-12-05", bookTo: "2026-12-05" })).toMatchObject({ bookFrom: "2026-12-05", bookTo: "2026-12-05" });
  });
  it("séjour minimal : entier de 1 à 365 nuits, ou vide", () => {
    for (const n of ["0", "1.5", "366", "x"]) expect(bad({ ...BASE, minLos: n }), n).toMatch(/durée minimale/);
    expect(ok({ ...BASE, minLos: "7" }).minLos).toBe(7);
    expect(ok({ ...BASE, minLos: "" }).minLos).toBeNull();
  });
  it("refuse les écritures numériques détournées (hexadécimal, exponentielle) et les dates hors de 2000-2100", () => {
    for (const d of ["0x10", "1e1", "5%"]) expect(bad({ ...BASE, discountPct: d }), d).toMatch(/pourcentage/);
    for (const n of ["0x10", "1e1"]) expect(bad({ ...BASE, minLos: n }), n).toMatch(/durée minimale/);
    expect(bad({ ...BASE, bookFrom: "0000-01-01", bookTo: "2026-12-01" })).toMatch(/n'est pas valide/);
    expect(bad({ ...BASE, bookFrom: "2026-12-01", bookTo: "9999-12-31" })).toMatch(/n'est pas valide/);
  });
  it("l'identifiant externe n'accepte pas de balisage ni de caractère de contrôle", () => {
    expect(bad({ ...BASE, externalRef: "<script>" })).toMatch(/identifiant/);
    expect(bad({ ...BASE, externalRef: "a".repeat(121) })).toMatch(/identifiant/);
    expect(ok({ ...BASE, externalRef: "PROMO-2026/11 #4" }).externalRef).toBe("PROMO-2026/11 #4");
  });
  it("une même promotion permanente n'a ni séjours ni fenêtre", () => {
    expect(ok({ ...BASE, channel: "AIRBNB", kind: "LOS", minLos: "7" })).toMatchObject({ stayFrom: null, stayTo: null, minLos: 7 });
  });
});

describe("doublons du registre", () => {
  const c = { channel: "BOOKING" as const, kind: "MOBILE", stayFrom: "2026-12-01", stayTo: "2026-12-15", listingId: null };
  it("même canal, même type, séjours qui se recoupent : doublon", () => {
    expect(findDuplicate([row({ id: "a", stayFrom: "2026-12-10", stayTo: "2026-12-20" })], c)?.id).toBe("a");
    expect(findDuplicate([row({ id: "a" })], c)?.id).toBe("a"); // permanente
  });
  it("séjours qui se touchent sans se recouper, type différent, canal différent, promotion terminée : pas de doublon", () => {
    expect(findDuplicate([row({ id: "a", stayFrom: "2026-12-15", stayTo: "2026-12-20" })], c)).toBeUndefined();
    expect(findDuplicate([row({ id: "a", kind: "COUNTRY" })], c)).toBeUndefined();
    expect(findDuplicate([row({ id: "a", channel: "AIRBNB" })], c)).toBeUndefined();
    expect(findDuplicate([row({ id: "a", status: "ENDED" })], c)).toBeUndefined();
  });
  it("annonces différentes : pas de doublon ; une promotion de toutes les annonces gêne toute annonce ; on s'ignore soi-même", () => {
    expect(findDuplicate([row({ id: "a", listingId: "l1" })], { ...c, listingId: "l2" })).toBeUndefined();
    expect(findDuplicate([row({ id: "a", listingId: null })], { ...c, listingId: "l2" })?.id).toBe("a");
    expect(findDuplicate([row({ id: "a" })], c, "a")).toBeUndefined();
  });
});

describe("état d'une promotion", () => {
  const now = new Date("2026-11-24T10:00:00Z"), days = (n: number) => new Date(+now - n * 86_400_000);
  it("en cours, à venir, passée, permanente", () => {
    expect(promotionView({ status: "ACTIVE", stayFrom: "2026-11-20", stayTo: "2026-12-01", verifiedAt: now }, TODAY, now)).toMatchObject({ state: "ACTIVE", phase: "RUNNING" });
    expect(promotionView({ status: "ACTIVE", stayFrom: "2026-12-05", stayTo: "2026-12-10", verifiedAt: now }, TODAY, now).phase).toBe("UPCOMING");
    expect(promotionView({ status: "ACTIVE", stayFrom: null, stayTo: null, verifiedAt: now }, TODAY, now).phase).toBe("PERMANENT");
  });
  it("des séjours passés rendent la promotion « expirée » sans attendre le balayage ; le dernier jour de la fenêtre (exclu) est déjà passé", () => {
    expect(promotionView({ status: "ACTIVE", stayFrom: "2026-11-01", stayTo: "2026-11-24", verifiedAt: now }, TODAY, now).state).toBe("EXPIRED");
    expect(promotionView({ status: "ACTIVE", stayFrom: "2026-11-01", stayTo: "2026-11-25", verifiedAt: now }, TODAY, now).state).toBe("ACTIVE");
  });
  it("terminée reste terminée ; planifiée reste planifiée", () => {
    expect(promotionView({ status: "ENDED", stayFrom: null, stayTo: null, verifiedAt: now }, TODAY, now).state).toBe("ENDED");
    expect(promotionView({ status: "PLANNED", stayFrom: null, stayTo: null, verifiedAt: null }, TODAY, now).state).toBe("PLANNED");
  });
  it("fraîcheur : jamais, fraîche, périmée au-delà de sept jours", () => {
    expect(VERIFY_MAX_AGE_DAYS).toBe(7);
    expect(promotionView({ status: "ACTIVE", stayFrom: null, stayTo: null, verifiedAt: null }, TODAY, now)).toMatchObject({ freshness: "NEVER", ageDays: null, verifyBefore: null });
    expect(promotionView({ status: "ACTIVE", stayFrom: null, stayTo: null, verifiedAt: days(7) }, TODAY, now)).toMatchObject({ freshness: "FRESH", ageDays: 7, verifyBefore: "2026-11-24" });
    expect(promotionView({ status: "ACTIVE", stayFrom: null, stayTo: null, verifiedAt: days(8) }, TODAY, now).freshness).toBe("STALE");
  });
});

describe("cumul inconnu entre promotions actives", () => {
  it("Booking Genius + Mobile sur les mêmes séjours : règle inconnue signalée des deux côtés", () => {
    const m = unknownStacking([row({ id: "g", kind: "GENIUS", label: "Genius" }), row({ id: "m", kind: "MOBILE", label: "Mobile" })], TODAY);
    expect(m.get("g")).toEqual(["Mobile"]); expect(m.get("m")).toEqual(["Genius"]);
  });
  it("Airbnb : règle connue (une seule s'applique, ou cumul) : aucun avertissement", () => {
    expect(unknownStacking([row({ id: "a", channel: "AIRBNB", kind: "LOS" }), row({ id: "b", channel: "AIRBNB", kind: "EARLY_BIRD" }), row({ id: "c", channel: "AIRBNB", kind: "TOP_RATED" })], TODAY).size).toBe(0);
  });
  it("séjours qui ne se recoupent pas, annonces différentes, terminées ou passées : aucun avertissement", () => {
    const g = row({ id: "g", kind: "GENIUS", stayFrom: "2026-12-01", stayTo: "2026-12-05" });
    expect(unknownStacking([g, row({ id: "m", kind: "MOBILE", stayFrom: "2026-12-05", stayTo: "2026-12-09" })], TODAY).size).toBe(0);
    expect(unknownStacking([{ ...g, listingId: "l1" }, row({ id: "m", kind: "MOBILE", listingId: "l2" })], TODAY).size).toBe(0);
    expect(unknownStacking([g, row({ id: "m", kind: "MOBILE", status: "ENDED" })], TODAY).size).toBe(0);
    expect(unknownStacking([row({ id: "g", kind: "GENIUS", stayFrom: "2026-10-01", stayTo: "2026-11-01" }), row({ id: "m", kind: "MOBILE" })], TODAY).size).toBe(0);
  });
});

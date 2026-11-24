import { describe, expect, it } from "vitest";
import { needsProof, validateDeclaration, validateMismatch } from "./confirmation";

const TODAY = "2026-11-24";
const ok = { scope: "Promotion posée sur Booking.com", date: "2026-11-24", proof: "", externalRef: "BK-123" };

describe("confirmation opérateur (US-103)", () => {
  it("promotion : identifiant OU preuve, l'un des deux obligatoire", () => {
    expect(validateDeclaration("CHANNEL_PROMO", ok, TODAY)).toMatchObject({ ok: true, value: { externalRef: "BK-123", proof: null, date: "2026-11-24" } });
    expect(validateDeclaration("CHANNEL_PROMO", { ...ok, externalRef: "", proof: "capture : https://exemple.test/c/1" }, TODAY)).toMatchObject({ ok: true, value: { externalRef: null } });
    const r = validateDeclaration("CHANNEL_PROMO", { ...ok, externalRef: "", proof: "" }, TODAY);
    expect(!r.ok && r.error).toContain("identifiant");
    expect(validateDeclaration("PROMO_REMOVAL", { ...ok, externalRef: "" }, TODAY).ok).toBe(false);
  });
  it("autres types : la preuve reste facultative", () => {
    expect(validateDeclaration("INVESTIGATION", { ...ok, externalRef: "" }, TODAY).ok).toBe(true);
    expect(needsProof("INVESTIGATION")).toBe(false);
    expect(needsProof("CHANNEL_PROMO")).toBe(true);
  });
  it.each([
    ["portée trop courte", { scope: "ok" }, "portée"],
    ["date absente", { date: "" }, "date d'entrée en vigueur"],
    ["date impossible", { date: "2026-02-30" }, "date d'entrée en vigueur"],
    ["date dans le futur", { date: "2026-11-25" }, "futur"],
    ["identifiant avec caractères interdits", { externalRef: "BK<script>" }, "identifiant"],
    ["preuve trop courte", { externalRef: "", proof: "x" }, "trop courte"],
  ])("refuse : %s", (_n, over, msg) => {
    const r = validateDeclaration("CHANNEL_PROMO", { ...ok, ...over }, TODAY);
    expect(!r.ok && r.error).toContain(msg);
  });
  it("une date passée est acceptée (on confirme ce qui a été fait)", () => {
    expect(validateDeclaration("CHANNEL_PROMO", { ...ok, date: "2026-10-01" }, TODAY).ok).toBe(true);
  });
  it("nettoyage : espaces et caractères de contrôle retirés, longueurs plafonnées", () => {
    const r = validateDeclaration("CHANNEL_PROMO", { scope: "  fait \n\t ainsi  ", date: TODAY, proof: "a".repeat(900), externalRef: " BK 1 " }, TODAY);
    expect(r.ok && r.value.scope).toBe("fait ainsi");
    expect(r.ok && r.value.proof!.length).toBe(900);
    expect(r.ok && r.value.externalRef).toBe("BK 1");
  });
  it("trop long : refus explicite, jamais de troncature silencieuse", () => {
    expect(validateDeclaration("CHANNEL_PROMO", { ...ok, proof: "a".repeat(1001) }, TODAY).ok).toBe(false);
    expect(validateDeclaration("CHANNEL_PROMO", { ...ok, scope: "a".repeat(2001) }, TODAY).ok).toBe(false);
  });
  it("la date ne précède pas l'approbation", () => {
    expect(validateDeclaration("CHANNEL_PROMO", { ...ok, date: "2026-11-20" }, TODAY, "2026-11-22").ok).toBe(false);
    expect(validateDeclaration("CHANNEL_PROMO", { ...ok, date: "2026-11-22" }, TODAY, "2026-11-22").ok).toBe(true);
  });
  it("écart : une description d'au moins 10 caractères", () => {
    expect(validateMismatch("Booking affiche 12 % au lieu de 8 %.")).toMatchObject({ ok: true });
    expect(validateMismatch("non").ok).toBe(false);
    expect(validateMismatch(undefined).ok).toBe(false);
  });
});

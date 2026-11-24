import { describe, expect, it } from "vitest";
import { buildRunbook, runbookProgress } from "./runbook";

const promo = (over: Record<string, unknown> = {}, channel: string | null = "BOOKING") => buildRunbook({ type: "CHANNEL_PROMO", channel, label: "Mobile", parameters: { kind: "MOBILE", discountPct: 8, label: "Mobile 8", stayFrom: "2026-12-10", stayTo: "2026-12-20", ...over }, soldNightlyCents: 9200 });

describe("guide pas-à-pas (US-102)", () => {
  it("promotion de canal : étapes ordonnées, canal et paramètres repris, consigne de sécurité non cochable", () => {
    const s = promo();
    expect(s.map((x) => x.id)).toEqual(["open", "check-scope", "check-active", "create", "compare-price", "capture", "stop-if-different"]);
    expect(s[0].title).toContain("Booking.com");
    expect(s.find((x) => x.id === "create")!.detail).toContain("Type : Tarif mobile · Remise : 8 %");
    expect(s.find((x) => x.id === "create")!.detail).toContain("Audience : Voyageurs sur mobile");
    expect(s.find((x) => x.id === "compare-price")!.detail).toContain("92");
    expect(s.at(-1)).toMatchObject({ kind: "STOP", checkable: false });
  });
  it("Airbnb : même guide, autre point d'entrée ; séjour minimal repris", () => {
    const s = promo({ kind: "LOS", minLos: 7 }, "AIRBNB");
    expect(s[0].title).toContain("Airbnb");
    expect(s.find((x) => x.id === "create")!.detail).toContain("Séjour minimal : 7 nuits");
  });
  it("type absent du registre de cumul : l'étape de sécurité vient en premier et dit de ne rien poser", () => {
    const s = promo({ kind: "INVENTÉ" });
    expect(s[0]).toMatchObject({ id: "unknown-type", kind: "STOP", checkable: false });
    expect(s[0].detail).toContain("INVENTÉ");
  });
  it("retrait, vérification, audit d'annonce et réglage PriceLabs ont leur propre guide", () => {
    const base = { channel: "AIRBNB", label: "x", soldNightlyCents: null, parameters: { promotionLabel: "Perso", promotions: [1, 2] } };
    expect(buildRunbook({ ...base, type: "PROMO_REMOVAL" }).map((x) => x.id)).toEqual(["open", "find", "disable", "compare-price", "capture", "stop-if-different"]);
    expect(buildRunbook({ ...base, type: "INVESTIGATION" })[1].detail).toContain("2");
    expect(buildRunbook({ ...base, type: "LISTING_AUDIT" })).toHaveLength(4);
    expect(buildRunbook({ ...base, type: "MIN_STAY_OVERRIDE", channel: null })[0].title).toContain("PriceLabs");
  });
  it("identifiants d'étape uniques et textes non vides, pour tous les types", () => {
    for (const type of ["CHANNEL_PROMO", "PROMO_REMOVAL", "INVESTIGATION", "LISTING_AUDIT", "PRICE_OVERRIDE"]) {
      const s = buildRunbook({ type, channel: "BOOKING", label: "L", parameters: { kind: "MOBILE", discountPct: 5 }, soldNightlyCents: 1000 });
      expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
      expect(s.every((x) => x.title.length > 5)).toBe(true);
    }
  });
  it("remise absente : étape d'arrêt, jamais « undefined % »", () => {
    for (const d of [undefined, "abc", 0]) {
      const s = promo({ discountPct: d });
      expect(s[0]).toMatchObject({ id: "missing-discount", blocking: true, checkable: false });
      expect(JSON.stringify(s)).not.toMatch(/undefined|NaN/);
    }
  });
  it("type inconnu ou remise absente : le guide ne peut jamais être « terminé »", () => {
    const s = promo({ kind: "INVENTÉ" });
    const p = runbookProgress(s, s.filter((x) => x.checkable).map((x) => x.id));
    expect(p).toMatchObject({ blocked: true, complete: false });
  });
  it("les étapes qui renvoient à la déclaration ne se cochent pas (pas de cercle)", () => {
    for (const type of ["INVESTIGATION", "LISTING_AUDIT", "PRICE_OVERRIDE"]) {
      const s = buildRunbook({ type, channel: "BOOKING", label: "L", parameters: {}, soldNightlyCents: null });
      expect(s.filter((x) => /ci-dessous/.test(x.title)).every((x) => !x.checkable)).toBe(true);
    }
  });
  it("déterministe", () => { expect(promo()).toEqual(promo()); });
  it("avancement : seules les étapes cochables et connues comptent", () => {
    const s = promo();
    expect(runbookProgress(s, [])).toEqual({ total: 6, done: 0, complete: false, blocked: false });
    expect(runbookProgress(s, ["open", "capture", "étape-disparue", "stop-if-different"])).toEqual({ total: 6, done: 2, complete: false, blocked: false });
    expect(runbookProgress(s, s.filter((x) => x.checkable).map((x) => x.id))).toEqual({ total: 6, done: 6, complete: true, blocked: false });
  });
});

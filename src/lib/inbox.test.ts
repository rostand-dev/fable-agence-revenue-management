import { describe, expect, it } from "vitest";
import { activeFilters, applyInbox, inboxHref, parseInboxQuery, priorityRanks, type InboxItem } from "./inbox";

const cand = (verdict = "APPROVE", risk = "LOW") => [{ audit: { verdict }, risk }];
const mk = (id: string, o: Partial<InboxItem> = {}): InboxItem => ({ id, propertyId: "p1", playbook: "PB-01", status: "OPEN", veto: false, priority: 1, stayFrom: "2026-12-20", stayTo: "2026-12-25", impactCents: 1000, candidates: cand(), selected: 0, ...o });
const known = { propertyIds: ["p1", "p2"], playbooks: ["PB-01", "PB-02"] };
const q = (raw = {}) => parseInboxQuery(raw, known);
const TODAY = "2026-12-01";

describe("parseInboxQuery", () => {
  it("valeurs par défaut, et paramètres inconnus ignorés sans erreur", () => {
    expect(q()).toEqual({ f: "a-traiter", p: "", pb: "", u: "", s: "priorite" });
    expect(q({ f: "n'importe", p: "zzz", pb: "PB-99", u: "x", s: "y" })).toEqual(q());
    expect(q({ p: ["p2", "p1"] }).p).toBe("p2");
  });
});

describe("applyInbox", () => {
  const all = [mk("a", { veto: true, priority: 9, propertyId: "p1" }), mk("b", { propertyId: "p2", playbook: "PB-02", stayFrom: "2026-12-05", impactCents: 5000 }), mk("c", { candidates: cand("NEEDS_HUMAN"), stayFrom: "2027-02-01", impactCents: null }), mk("d", { status: "DECIDED" })];
  it("statut par défaut : seules les situations ouvertes", () => expect(applyInbox(all, q(), TODAY).map((o) => o.id)).toEqual(["a", "b", "c"]));
  it("filtre logement et playbook", () => {
    expect(applyInbox(all, q({ p: "p2" }), TODAY).map((o) => o.id)).toEqual(["b"]);
    expect(applyInbox(all, q({ pb: "PB-02" }), TODAY).map((o) => o.id)).toEqual(["b"]);
  });
  it("urgence : séjour sous 14 jours, veto, validation renforcée", () => {
    expect(applyInbox(all, q({ u: "urgent" }), TODAY).map((o) => o.id)).toEqual(["b"]);
    expect(applyInbox(all, q({ u: "veto" }), TODAY).map((o) => o.id)).toEqual(["a"]);
    expect(applyInbox(all, q({ u: "renforcee" }), TODAY).map((o) => o.id)).toEqual(["c"]);
  });
  it("tri par impact : décroissant, négatifs avant le non chiffrable, deux null restent dans l'ordre de priorité", () => {
    const l = [mk("n1", { impactCents: null }), mk("neg", { impactCents: -500 }), mk("n2", { impactCents: null }), mk("big", { impactCents: 9000 }), mk("zero", { impactCents: 0 })];
    expect(applyInbox(l, q({ s: "impact" }), TODAY).map((o) => o.id)).toEqual(["big", "zero", "neg", "n1", "n2"]);
  });
  it("tri par séjour : le plus proche d'abord, séjours terminés en dernier (ordre différent du tri par impact)", () => {
    const l = [mk("loin", { stayFrom: "2027-03-01", stayTo: "2027-03-05", impactCents: 100 }), mk("fini", { stayFrom: "2026-11-01", stayTo: "2026-11-05", impactCents: 9000 }), mk("proche", { stayFrom: "2026-12-03", stayTo: "2026-12-06", impactCents: 50 })];
    expect(applyInbox(l, q({ s: "sejour" }), TODAY).map((o) => o.id)).toEqual(["proche", "loin", "fini"]);
    expect(applyInbox(l, q({ s: "impact" }), TODAY).map((o) => o.id)).toEqual(["fini", "loin", "proche"]);
  });
  it("urgence : bornes J+14 / J+15, séjour en cours urgent, séjour terminé jamais", () => {
    const l = [mk("j14", { stayFrom: "2026-12-15", stayTo: "2026-12-18" }), mk("j15", { stayFrom: "2026-12-16", stayTo: "2026-12-18" }), mk("encours", { stayFrom: "2026-11-28", stayTo: "2026-12-03" }), mk("fini", { stayFrom: "2026-11-20", stayTo: "2026-11-30" })];
    expect(applyInbox(l, q({ u: "urgent" }), TODAY).map((o) => o.id)).toEqual(["j14", "encours"]);
  });
  it("un veto déjà traité n'entre pas dans « garde-fous »", () => {
    expect(applyInbox([mk("x", { veto: true, status: "DECIDED" })], q({ f: "garde-fous" }), TODAY)).toEqual([]);
  });
  it("garde-fous : veto ou option rejetée par l'auditeur, parmi les ouvertes", () => {
    const g = [...all, mk("e", { candidates: cand("REJECT") })];
    expect(applyInbox(g, q({ f: "garde-fous" }), TODAY).map((o) => o.id)).toEqual(["a", "e"]);
  });
  it("traitées et toutes", () => {
    expect(applyInbox(all, q({ f: "traitees" }), TODAY).map((o) => o.id)).toEqual(["d"]);
    expect(applyInbox(all, q({ f: "toutes" }), TODAY)).toHaveLength(4);
  });
});

describe("rang de priorité", () => {
  it("filtrer ne renumérote jamais : le rang vient du classement complet des ouvertes", () => {
    const all = [mk("a"), mk("b"), mk("c", { status: "DECIDED" }), mk("d")];
    const ranks = priorityRanks(all);
    expect(ranks.get("d")).toBe(3);
    expect(ranks.has("c")).toBe(false);
    expect(applyInbox(all, q({ f: "toutes" }), TODAY).map((o) => ranks.get(o.id) ?? null)).toEqual([1, 2, null, 3]);
    const l = [mk("a", { propertyId: "p1" }), mk("b", { propertyId: "p2" }), mk("c", { propertyId: "p1" }), mk("d", { propertyId: "p2" })];
    const r = priorityRanks(l);
    expect(applyInbox(l, q({ p: "p2" }), TODAY).map((o) => r.get(o.id))).toEqual([2, 4]);
  });
});

describe("liens de filtre", () => {
  it("href minimal et réversible", () => {
    expect(inboxHref(q(), {})).toBe("/");
    expect(inboxHref(q(), { p: "p1", u: "urgent", s: "impact" })).toBe("/?p=p1&u=urgent&s=impact");
    expect(inboxHref(q({ f: "toutes", p: "p1" }), { p: "" })).toBe("/?f=toutes");
  });
  it("compte les filtres actifs", () => { expect(activeFilters(q())).toBe(0); expect(activeFilters(q({ p: "p1", u: "veto", s: "impact", f: "toutes" }))).toBe(4); });
});

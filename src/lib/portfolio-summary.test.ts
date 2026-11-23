import { describe, expect, it } from "vitest";
import type { InboxItem } from "./inbox";
import { portfolioOccupation, summarizePortfolio } from "./portfolio-summary";

const cand = (verdict = "APPROVE") => [{ audit: { verdict }, risk: "LOW" }];
const opp = (id: string, propertyId: string, o: Partial<InboxItem> = {}): InboxItem => ({ id, propertyId, playbook: "PB-01", status: "OPEN", veto: false, priority: 1, stayFrom: "2027-03-01", stayTo: "2027-03-05", impactCents: 0, candidates: cand(), selected: 0, ...o });
const P = [{ id: "a", name: "Zèbre", status: "ACTIVE", isDemo: false }, { id: "b", name: "Alpha", status: "ACTIVE", isDemo: true }, { id: "c", name: "Brouillon", status: "ONBOARDING", isDemo: false }];
const T = "2026-12-01";

describe("summarizePortfolio", () => {
  it("totaux : ouverts, vetos, urgents, validation renforcée, garde-fous ; seuls les dossiers ouverts comptent", () => {
    const s = summarizePortfolio(P, [
      opp("1", "a", { veto: true, stayFrom: "2026-12-05", stayTo: "2026-12-08" }),
      opp("2", "a", { candidates: cand("NEEDS_HUMAN") }),
      opp("3", "b", { stayFrom: "2026-12-10", stayTo: "2026-12-12" }),
      opp("4", "b", { status: "DECIDED", veto: true }),
    ], [], T);
    expect(s).toMatchObject({ properties: 3, active: 2, open: 3, vetoes: 1, urgent: 2, reinforced: 1, guarded: 1 });
  });
  it("un dossier d'un logement inconnu n'entre jamais dans les totaux", () => {
    expect(summarizePortfolio(P, [opp("x", "ailleurs", { veto: true })], [], T).open).toBe(0);
  });
  it("lignes triées : veto d'abord, puis urgence, puis volume, puis nom", () => {
    const s = summarizePortfolio(P, [opp("1", "a"), opp("2", "b", { veto: true }), opp("3", "a")], [], T);
    expect(s.rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
    const eq = summarizePortfolio(P, [], [], T);
    expect(eq.rows.map((r) => r.name)).toEqual(["Alpha", "Brouillon", "Zèbre"]);
  });
  it("actions en attente : à exécuter, à vérifier, en échec ; les autres états sont ignorés", () => {
    const acts = ["APPROVED", "APPROVED", "EXECUTED", "FAILED", "CLOSED", "VERIFIED", "REJECTED"].map((status, i) => ({ status, opportunityId: "o" + i }));
    expect(summarizePortfolio(P, [], acts, T).actions).toEqual({ toExecute: 2, toVerify: 1, failed: 1 });
  });
  it("portefeuille vide : tout à zéro, aucune erreur", () => {
    expect(summarizePortfolio([], [], [], T)).toMatchObject({ properties: 0, active: 0, open: 0, rows: [], actions: { toExecute: 0, toVerify: 0, failed: 0 } });
  });
});

describe("portfolioOccupation", () => {
  const resa = (propertyId: string, checkIn: string, checkOut: string, nights: number) => ({ propertyId, channel: "AIRBNB", checkIn, checkOut, nights, grossRoomCents: 10000 * nights, commissionCents: null, paymentFeeCents: null, bookedAt: "2026-01-01", status: "CONFIRMED" });
  const M = ["2026-03"];
  it("deux logements réservés les mêmes nuits : l'occupation reste un taux (jamais plus de 100 %)", () => {
    const o = portfolioOccupation(P, [resa("a", "2026-03-01", "2026-03-11", 10), resa("b", "2026-03-01", "2026-03-11", 10)], M);
    expect(o).toMatchObject({ nights: 20, available: 62, properties: 2 });
    expect(o.rate).toBeCloseTo(20 / 62);
    expect(o.rate!).toBeLessThanOrEqual(1);
  });
  it("sans aucune réservation lue : inconnue (null), jamais 0 %", () => {
    expect(portfolioOccupation(P, [], M).rate).toBeNull();
  });
  it("un logement sans historique ou en saisie n'entre pas dans le dénominateur", () => {
    const o = portfolioOccupation(P, [resa("a", "2026-03-01", "2026-03-11", 10), resa("c", "2026-03-01", "2026-03-11", 10)], M);
    expect(o).toMatchObject({ nights: 10, available: 31, properties: 1 });
  });
});

describe("cas supplémentaires du résumé", () => {
  it("un séjour terminé n'est pas urgent ; la validation renforcée suit l'option retenue, pas une autre candidate", () => {
    const fini = opp("1", "a", { stayFrom: "2026-11-01", stayTo: "2026-11-05" });
    const autre = opp("2", "a", { candidates: [{ audit: { verdict: "APPROVE" }, risk: "LOW" }, { audit: { verdict: "NEEDS_HUMAN" }, risk: "LOW" }], selected: 0 });
    const s = summarizePortfolio(P, [fini, autre], [], T);
    expect(s.urgent).toBe(0);
    expect(s.reinforced).toBe(0);
  });
});

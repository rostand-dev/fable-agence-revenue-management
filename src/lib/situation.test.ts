import { describe, expect, it } from "vitest";
import type { Candidate } from "./engine/types";
import { decisionOptions, followUpPending, needsComment, quickApprovable, situationRole } from "./situation";

const candidate = (over: { type?: string; risk?: string; verdict?: string } = {}) =>
  ({ type: over.type ?? "PRICE_OVERRIDE", risk: over.risk ?? "LOW", audit: { verdict: over.verdict ?? "APPROVE", checks: [] }, parameters: {} }) as unknown as Candidate;
const open = { status: "OPEN", veto: false, playbook: "PB-01" };

describe("quickApprovable (« Approuver » sur la carte du mode poche)", () => {
  it("option conforme, ouverte, avec le droit de décision", () => {
    expect(needsComment(candidate(), "PB-01")).toBe(false);
    expect(quickApprovable(open, candidate(), true)).toBe(true);
  });
  it.each([
    ["sans le droit de décision", open, candidate(), false],
    ["sous veto", { ...open, veto: true }, candidate(), true],
    ["validation renforcée", open, candidate({ verdict: "NEEDS_HUMAN" }), true],
    ["option rejetée par l'auditeur", open, candidate({ verdict: "REJECT" }), true],
    ["risque élevé", open, candidate({ risk: "HIGH" }), true],
    ["risque critique", open, candidate({ risk: "CRITICAL" }), true],
    ["déjà décidée", { ...open, status: "DECIDED" }, candidate(), true],
    ["différée", { ...open, status: "DEFERRED" }, candidate(), true],
  ] as const)("jamais %s", (_, o, c, canDecide) => {
    expect(quickApprovable(o, c, canDecide)).toBe(false);
  });
  it("jamais quand le playbook exige un commentaire", () => {
    // PB-12 : une baisse du prix de base demande l'accord écrit du propriétaire (approver REVENUE_MANAGER_AND_OWNER)
    const c = { ...candidate({ type: "BASE_PRICE_CHANGE" }), parameters: { fromCents: 12000, toCents: 10000 } } as unknown as Candidate;
    expect(needsComment(c, "PB-12")).toBe(true);
    expect(quickApprovable({ ...open, playbook: "PB-12" }, c, true)).toBe(false);
  });
});

describe("situationRole", () => {
  it("le veto passe avant le reste", () => {
    expect(situationRole({ veto: true, playbook: "PB-10" }, candidate()).label).toBe("Veto économique");
    expect(situationRole(open, candidate({ verdict: "NEEDS_HUMAN" })).label).toBe("Validation renforcée");
    expect(situationRole(open, candidate()).label).toBe("Option conforme");
  });
});

describe("decisionOptions (boutons d'un dossier, version complète et mode décision)", () => {
  const may = (o: { status: string; veto: boolean }, c = candidate(), rights: { canDecide?: boolean; hasAction?: boolean } = {}) =>
    decisionOptions(o, c, { canDecide: rights.canDecide ?? true, hasAction: rights.hasAction ?? false });
  const nothing = { approve: false, reject: false, defer: false, reopen: false };

  it("dossier ouvert, option conforme : approuver, rejeter, différer", () => {
    expect(may(open)).toEqual({ approve: true, reject: true, defer: true, reopen: false });
  });
  it("sous veto : pas de report", () => {
    expect(may({ ...open, veto: true })).toEqual({ approve: true, reject: true, defer: false, reopen: false });
  });
  it("option rejetée par l'auditeur : jamais approuvable", () => {
    expect(may(open, candidate({ verdict: "REJECT" }))).toEqual({ approve: false, reject: true, defer: true, reopen: false });
  });
  it("sans le droit de décision : aucun bouton", () => {
    expect(may(open, candidate(), { canDecide: false })).toEqual(nothing);
    expect(may({ ...open, status: "DECIDED" }, candidate(), { canDecide: false })).toEqual(nothing);
  });
  it.each(["DECIDED", "DEFERRED"])("%s sans action : réouverture seule", (status) => {
    expect(may({ ...open, status })).toEqual({ ...nothing, reopen: true });
  });
  it("décidé avec une action : rien à reprendre ici", () => {
    expect(may({ ...open, status: "DECIDED" }, candidate(), { hasAction: true })).toEqual(nothing);
  });
  it("expiré : aucune réouverture", () => {
    expect(may({ ...open, status: "EXPIRED" })).toEqual(nothing);
  });
});

describe("followUpPending (suivi d'application déplié dans le mode décision)", () => {
  it.each(["APPROVED", "EXECUTING", "EXECUTED", "FAILED"])("%s attend un geste ou une vérification", (status) => {
    expect(followUpPending(status, 0)).toBe(true);
  });
  it.each(["MEASURING", "CLOSED"])("%s reste replié sans alerte", (status) => {
    expect(followUpPending(status, 0)).toBe(false);
    expect(followUpPending(status, 1)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { approvalRequirement, MIN_COMMENT_LENGTH } from "./approval";
import { PLAYBOOKS } from "./playbooks";
import type { Candidate } from "./types";

const c = (type: Candidate["type"], risk: Candidate["risk"], verdict: Candidate["audit"]["verdict"] = "APPROVE") => ({ type, risk, audit: { verdict, rules: [] } }) as Pick<Candidate, "type" | "risk" | "audit">;

describe("exigence de commentaire à l'approbation", () => {
  it("risque faible, option conforme, playbook du seul responsable : aucun commentaire exigé", () => {
    expect(approvalRequirement(c("PRICE_OVERRIDE", "LOW"), "PB-01")).toEqual({ commentRequired: false, reasons: [] });
  });
  it("un risque élevé ou critique, ou une validation humaine demandée par l'auditeur, exigent un commentaire", () => {
    expect(approvalRequirement(c("PRICE_OVERRIDE", "HIGH"), "PB-01").reasons).toEqual(["action à risque élevé"]);
    expect(approvalRequirement(c("MIN_PRICE_CHANGE", "CRITICAL"), "PB-01").reasons).toEqual(["action à risque critique"]);
    expect(approvalRequirement(c("PRICE_OVERRIDE", "LOW", "NEEDS_HUMAN"), "PB-01").commentRequired).toBe(true);
  });
  it("un playbook qui demande la validation du propriétaire exige un commentaire pour toute action exécutable, même à risque faible", () => {
    const owner = (Object.values(PLAYBOOKS).filter((p) => p.approver === "REVENUE_MANAGER_AND_OWNER")).map((p) => p.code);
    expect(owner).toEqual(expect.arrayContaining(["PB-02", "PB-11", "PB-12", "PB-13"]));
    for (const code of owner) {
      const r = approvalRequirement(c("PRICE_OVERRIDE", "LOW"), code);
      expect(r.commentRequired, code).toBe(true);
      expect(r.reasons[0]).toContain(code);
    }
  });
  it("l'inaction, l'audit d'annonce et la vérification manuelle n'exigent rien de plus, même dans un playbook du propriétaire", () => {
    for (const type of ["NO_ACTION", "LISTING_AUDIT", "INVESTIGATION"] as const) expect(approvalRequirement(c(type, "LOW"), "PB-02").commentRequired, type).toBe(false);
  });
  it("un playbook inconnu ou absent ne change rien", () => {
    expect(approvalRequirement(c("PRICE_OVERRIDE", "LOW"), "PB-99").commentRequired).toBe(false);
    expect(approvalRequirement(c("PRICE_OVERRIDE", "LOW")).commentRequired).toBe(false);
  });
  it("les motifs s'additionnent", () => {
    expect(approvalRequirement(c("BASE_PRICE_CHANGE", "HIGH", "NEEDS_HUMAN"), "PB-02").reasons).toHaveLength(3);
    expect(MIN_COMMENT_LENGTH).toBe(8);
  });
});

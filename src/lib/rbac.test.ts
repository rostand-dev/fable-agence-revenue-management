import { describe, expect, it } from "vitest";
import { can, denyMessage, executePermission, GRANTS, isRole, normalizeRole, PERMISSIONS, PERMISSION_LABEL, rolesWith, ROLE_LABEL, ROLE_SUMMARY, ROLES } from "./rbac";

describe("rôles et droits (US-084)", () => {
  it("chaque rôle a un libellé, un résumé et une ligne de la matrice ; chaque droit un libellé", () => {
    for (const r of ROLES) { expect(ROLE_LABEL[r].length, r).toBeGreaterThan(3); expect(ROLE_SUMMARY[r].length, r).toBeGreaterThan(20); expect(GRANTS[r], r).toBeDefined(); }
    for (const p of PERMISSIONS) expect(PERMISSION_LABEL[p].length, p).toBeGreaterThan(10);
  });

  it("le propriétaire du compte garde tous les droits (aucune régression pour les comptes existants)", () => {
    for (const p of PERMISSIONS) expect(can("OWNER", p), p).toBe(true);
  });

  it("seuls l'administrateur, le revenue manager et le propriétaire du compte décident et reviennent en arrière", () => {
    expect(rolesWith("decision.decide").sort()).toEqual(["OWNER", "REVENUE_MANAGER", "TENANT_ADMIN"]);
    expect(rolesWith("action.rollback").sort()).toEqual(["OWNER", "REVENUE_MANAGER", "TENANT_ADMIN"]);
    for (const r of ["ANALYST", "OTA_OPERATOR", "OWNER_VIEWER", "AUDITOR"] as const) { expect(can(r, "decision.decide"), r).toBe(false); expect(can(r, "action.rollback"), r).toBe(false); }
  });

  it("l'opérateur OTA applique les procédures manuelles, jamais l'écriture PriceLabs", () => {
    expect(can("OTA_OPERATOR", executePermission("MANUAL_RUNBOOK"))).toBe(true);
    expect(can("OTA_OPERATOR", executePermission("API_PRICELABS"))).toBe(false);
    expect(can("OTA_OPERATOR", executePermission("INTERNAL"))).toBe(false);
    expect(can("OTA_OPERATOR", "action.verify")).toBe(true);
  });

  it("le rapport mensuel (US-112) est certifié par les rôles de décision seulement : ni l'opérateur OTA, ni la lecture seule", () => {
    expect(rolesWith("report.certify").sort()).toEqual(["OWNER", "REVENUE_MANAGER", "TENANT_ADMIN"]);
    for (const r of ["ANALYST", "OWNER_VIEWER", "AUDITOR", "OTA_OPERATOR"] as const) expect(can(r, "report.certify"), r).toBe(false);
  });
  it("la suppression d'un logement, définitive, est réservée au propriétaire du compte et à l'administrateur", () => {
    expect(rolesWith("property.delete").sort()).toEqual(["OWNER", "TENANT_ADMIN"]);
    for (const r of ["REVENUE_MANAGER", "ANALYST", "OTA_OPERATOR", "OWNER_VIEWER", "AUDITOR"] as const) expect(can(r, "property.delete"), r).toBe(false);
    expect(denyMessage("ANALYST", "property.delete")).toBe("Votre rôle (Analyste) ne permet pas de supprimer un logement.");
  });
  it("le registre des promotions (US-100) est tenu par les rôles de décision et l'opérateur OTA, jamais par la lecture seule", () => {
    expect(rolesWith("promotion.manage").sort()).toEqual(["OTA_OPERATOR", "OWNER", "REVENUE_MANAGER", "TENANT_ADMIN"]);
    for (const r of ["ANALYST", "OWNER_VIEWER", "AUDITOR"] as const) expect(can(r, "promotion.manage"), r).toBe(false);
  });

  it("l'auditeur lit le journal et ne modifie rien ; l'analyste et le propriétaire du bien n'ont aucun droit d'écriture", () => {
    expect(GRANTS.AUDITOR).toEqual(["audit.read"]);
    expect(GRANTS.ANALYST).toEqual([]);
    expect(GRANTS.OWNER_VIEWER).toEqual([]);
  });

  it("un rôle inconnu en base est lu en lecture seule, jamais comme un administrateur", () => {
    expect(isRole("ROOT")).toBe(false);
    expect(normalizeRole("ROOT")).toBe("OWNER_VIEWER");
    expect(normalizeRole(null)).toBe("OWNER_VIEWER");
    expect(normalizeRole("")).toBe("OWNER_VIEWER");
    expect(normalizeRole("REVENUE_MANAGER")).toBe("REVENUE_MANAGER");
    for (const p of PERMISSIONS) expect(can(normalizeRole("ROOT"), p), p).toBe(false);
  });

  it("le message de refus nomme le rôle et l'acte refusé", () => {
    expect(denyMessage("ANALYST", "decision.decide")).toBe("Votre rôle (Analyste) ne permet pas de décider d'un dossier (approuver, rejeter, différer ou rouvrir).");
    for (const p of PERMISSIONS) expect(denyMessage("ANALYST", p)).toContain("Analyste");
  });
});

import { describe, expect, it } from "vitest";
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_ORDER, AUDIT_TYPES, MASKED, auditCategoryOf, auditLabel, isAuditCategory, isAuditType, redactPayload, typesOfCategory, type AuditType } from "./types";

describe("catalogue des événements d'audit", () => {
  const all = Object.keys(AUDIT_TYPES) as AuditType[];
  it("chaque événement a un libellé et une famille connue", () => {
    for (const t of all) {
      expect(AUDIT_TYPES[t].label.length, t).toBeGreaterThan(3);
      expect(isAuditCategory(AUDIT_TYPES[t].category), t).toBe(true);
    }
  });
  it("chaque famille annoncée contient au moins un événement, et les familles partitionnent le catalogue", () => {
    expect(AUDIT_CATEGORY_ORDER.sort()).toEqual(Object.keys(AUDIT_CATEGORIES).sort());
    const seen = AUDIT_CATEGORY_ORDER.flatMap((c) => { expect(typesOfCategory(c).length, c).toBeGreaterThan(0); return typesOfCategory(c); });
    expect([...seen].sort()).toEqual([...all].sort());
  });
  it("un type inconnu (ancien événement) reste affiché tel quel, classé « Système »", () => {
    expect(isAuditType("ancien.evenement")).toBe(false);
    expect(auditLabel("ancien.evenement")).toBe("ancien.evenement");
    expect(auditCategoryOf("ancien.evenement")).toBe("SYSTEM");
    expect(auditLabel("action.approved")).toBe("Action approuvée");
  });
  it("les noms d'événements suivent la forme objet.verbe", () => { for (const t of all) expect(t).toMatch(/^[a-z]+\.[a-z_]+$/); });
});

describe("masquage des secrets dans le journal", () => {
  it("masque jetons, clés et mots de passe à tous les niveaux, garde le reste", () => {
    const out = redactPayload({ comment: "ok", apiKey: "sk-123", nested: { token: "abc", password: "x", list: [{ api_key_enc: "zzz", fine: 1 }] }, keyHint: "…1234" }) as any;
    expect(out.comment).toBe("ok");
    expect(out.apiKey).toBe(MASKED);
    expect(out.nested.token).toBe(MASKED);
    expect(out.nested.password).toBe(MASKED);
    expect(out.nested.list[0].api_key_enc).toBe(MASKED);
    expect(out.nested.list[0].fine).toBe(1);
    expect(out.keyHint).toBe("…1234");
  });
  it("US-034 : l'identité d'un voyageur n'entre pas dans le journal, mais l'e-mail d'un propriétaire (consigné à dessein) et les compteurs restent", () => {
    const out = redactPayload({ guest: { first_name: "Anne" }, guest_email: "a@b.fr", private_notes: "code", owner: { email: "p@x.fr" }, guests_count: 2 }) as any;
    expect(out.guest).toBe(MASKED); expect(out.guest_email).toBe(MASKED); expect(out.private_notes).toBe(MASKED);
    expect(out.owner.email).toBe("p@x.fr"); expect(out.guests_count).toBe(2);
  });
  it("laisse intacts les valeurs simples et ne plante pas sur les cycles profonds", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload("a")).toBe("a");
    let deep: any = { v: 1 }; for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(() => redactPayload(deep)).not.toThrow();
  });
});

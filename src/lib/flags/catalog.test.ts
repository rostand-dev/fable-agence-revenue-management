import { describe, expect, it } from "vitest";
import { FLAGS, resolveFlag, TENANT_SCOPE_ID, type FlagRow } from "./catalog";

const off = (flag: string, scope: FlagRow["scope"], scopeId = TENANT_SCOPE_ID): FlagRow => ({ flag, scope, scopeId, enabled: false });
describe("drapeaux : résolution restrictive", () => {
  it("tout est actif par défaut", () => { for (const f of FLAGS) expect(resolveFlag(f.id, [], { propertyId: "p1", provider: "pricelabs" }).enabled).toBe(true); });
  it("le niveau propriétaire coupe tous les logements et intégrations", () => {
    const r = resolveFlag("write.api", [off("write.api", "TENANT")], { propertyId: "p1", provider: "pricelabs" });
    expect(r).toMatchObject({ enabled: false, by: "TENANT" });
    expect(r.reason).toContain("tout votre espace");
  });
  it("un logement coupé ne touche pas les autres", () => {
    const rows = [off("write.api", "PROPERTY", "p1")];
    expect(resolveFlag("write.api", rows, { propertyId: "p1" }).enabled).toBe(false);
    expect(resolveFlag("write.api", rows, { propertyId: "p2" }).enabled).toBe(true);
  });
  it("une intégration coupée ne touche pas les autres", () => {
    const rows = [off("sync.scheduled", "INTEGRATION", "pricelabs")];
    expect(resolveFlag("sync.scheduled", rows, { provider: "pricelabs" }).enabled).toBe(false);
    expect(resolveFlag("sync.scheduled", rows, { provider: "superhote" }).enabled).toBe(true);
    expect(resolveFlag("sync.scheduled", rows, {}).enabled).toBe(true);
  });
  it("un niveau fin ne peut pas rétablir ce qu'un niveau large coupe", () => {
    const rows: FlagRow[] = [off("write.api", "TENANT"), { flag: "write.api", scope: "PROPERTY", scopeId: "p1", enabled: true }];
    expect(resolveFlag("write.api", rows, { propertyId: "p1" }).enabled).toBe(false);
  });
  it("une ligne dans un niveau non prévu pour ce drapeau est ignorée", () => {
    expect(resolveFlag("review.scheduled", [off("review.scheduled", "INTEGRATION", "pricelabs")], { provider: "pricelabs" }).enabled).toBe(true);
  });
  it("un drapeau inconnu est désactivé par précaution", () => { expect(resolveFlag("nimporte" as any, []).enabled).toBe(false); });
});

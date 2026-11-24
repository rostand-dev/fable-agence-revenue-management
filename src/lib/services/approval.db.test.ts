import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { approvalRequirement } from "../engine/approval";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { seedDemo } from "./seed";

let t: Awaited<ReturnType<typeof makeTenant>>;
beforeAll(async () => { t = await makeTenant("approbation"); await seedDemo(t.tenantId); }, 120_000);

describe("approbation renforcée : le serveur refuse sans commentaire, quel que soit l'écran", () => {
  it("un playbook du propriétaire exige un commentaire même pour une option conforme à risque faible, et l'accepte ensuite", async () => {
    // dossier fabriqué : playbook propriétaire (PB-02), option exécutable conforme à risque faible, aucun autre motif de commentaire
    const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
    let found: { id: string; i: number; reasons: string[] } | null = null;
    for (const o of opps) {
      const cands = o.candidates as Candidate[];
      const i = cands.findIndex((c) => c.type === "PRICE_OVERRIDE" || c.type === "BASE_PRICE_CHANGE");
      if (i < 0) continue;
      const forged = cands.map((c, k) => (k === i ? { ...c, risk: "LOW", audit: { ...c.audit, verdict: "APPROVE" } } : c)) as Candidate[];
      await db.update(schema.opportunities).set({ playbook: "PB-02", candidates: forged }).where(eq(schema.opportunities.id, o.id));
      found = { id: o.id, i, reasons: approvalRequirement(forged[i], "PB-02").reasons };
      break;
    }
    expect(found, "la démonstration doit contenir au moins une option de prix exécutable").toBeTruthy();
    expect(found!.reasons.join(" ")).toContain("validation du propriétaire");
    await expect(D.approve(t.actor, found!.id, found!.i, "")).rejects.toThrow(/commentaire est obligatoire.*propriétaire/);
    await expect(D.approve(t.actor, found!.id, found!.i, "court")).rejects.toThrow(/commentaire est obligatoire/);
    const id = await D.approve(t.actor, found!.id, found!.i, "Demande lointaine confirmée par le rythme du marché.");
    expect(id).toBeTruthy();
  });
});

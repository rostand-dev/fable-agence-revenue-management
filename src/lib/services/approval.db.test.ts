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
  it("un playbook du propriétaire exige un commentaire même pour une option conforme à risque moyen, et l'accepte ensuite", async () => {
    const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
    let found: { id: string; i: number; reasons: string[] } | null = null;
    for (const o of opps) {
      const i = (o.candidates as Candidate[]).findIndex((c) => c.audit.verdict !== "REJECT" && c.type !== "NO_ACTION" && c.risk !== "HIGH" && c.risk !== "CRITICAL" && c.audit.verdict !== "NEEDS_HUMAN" && approvalRequirement(c, o.playbook).commentRequired);
      if (i >= 0) { found = { id: o.id, i, reasons: approvalRequirement((o.candidates as Candidate[])[i], o.playbook).reasons }; break; }
    }
    expect(found, "la démonstration doit contenir une option de playbook « propriétaire » sans autre motif de commentaire (PB-02, option de prix daté)").toBeTruthy();
    expect(found!.reasons.join(" ")).toContain("validation du propriétaire");
    await expect(D.approve(t.actor, found!.id, found!.i, "")).rejects.toThrow(/commentaire est obligatoire.*propriétaire/);
    await expect(D.approve(t.actor, found!.id, found!.i, "court")).rejects.toThrow(/commentaire est obligatoire/);
    const id = await D.approve(t.actor, found!.id, found!.i, "Demande lointaine confirmée par le rythme du marché.");
    expect(id).toBeTruthy();
  });
});

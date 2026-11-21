import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";

/** Migration 0013 : l'alerte « minimum PriceLabs sous le plancher » passe de PB-11 (réservé au blueprint) à PB-13. */
describe("migration 0013 : PB-11 (minimum PriceLabs) → PB-13", () => {
  const file = path.join(process.cwd(), "drizzle", "0013_pb13_minimum_pricelabs.sql");
  const run = () => db.execute(sql.raw(fs.readFileSync(file, "utf8")));

  async function opp(tenantId: string, propertyId: string, playbook: string, reasonCode: string, dedupe: string) {
    const id = newId("opp");
    await db.insert(schema.opportunities).values({
      id, tenantId, propertyId, code: `T-${id}`, playbook, reasonCode, title: "test", stayFrom: "2026-11-20", stayTo: "2026-11-21",
      dedupeKey: `${propertyId}|${playbook}|${dedupe}`, signals: {}, diagnosis: {}, candidates: [], expiresAt: "2026-11-21",
    });
    return id;
  }
  const row = async (id: string) => (await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, id)))[0];

  it("renomme l'alerte et sa clé de dédoublonnage, sans toucher aux autres situations ; rejouable", async () => {
    const t = await makeTenant("pb13");
    const p = await makeProperty(t.tenantId);
    const alert = await opp(t.tenantId, p, "PB-11", "MIN_PRICE_BELOW_FLOOR", "min");
    const other = await opp(t.tenantId, p, "PB-11", "BASE_LOW", "2026-11-20"); // un futur vrai PB-11 du blueprint n'est pas renommé
    const veto = await opp(t.tenantId, p, "PB-06", "FLOOR_BREACH", "AIRBNB");

    await run();
    await run(); // deuxième passage : aucune erreur, aucun changement

    expect(await row(alert)).toMatchObject({ playbook: "PB-13", dedupeKey: `${p}|PB-13|min` });
    expect(await row(other)).toMatchObject({ playbook: "PB-11", dedupeKey: `${p}|PB-11|2026-11-20` });
    expect(await row(veto)).toMatchObject({ playbook: "PB-06", dedupeKey: `${p}|PB-06|AIRBNB` });
  });
});

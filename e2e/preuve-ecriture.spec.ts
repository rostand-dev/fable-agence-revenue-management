import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";
import { deplierDossier, dossiersTranches } from "./helpers/dossier";

// US-092 : la fiche dossier montre la preuve d'une écriture PriceLabs (reçu, empreintes, état avant / après) sans défilement horizontal, sur les trois formats.
// Le jeu de test insère une ligne de journal d'écriture sur une action de démonstration existante, puis la retire.
test("Dossier : preuve d'écriture PriceLabs lisible (avant / après, reçu, empreintes)", async ({ page }, info) => {
  test.skip(!hasDatabase(), "Ligne de journal insérée en base : DATABASE_URL requis.");
  const hrefs = await dossiersTranches(page);
  expect(hrefs.length).toBeGreaterThan(0);
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  const tag = info.project.name.replace(/\W/g, ""), stamp = Date.now().toString(36);
  const wids: string[] = [];
  await c.connect();
  try {
    await c.query("delete from external_writes where id like 'xw_e2e_%' and created_at < now() - interval '1 hour'"); // restes d'un arrêt brutal
    // premier dossier de l'historique qui porte une action non annulée (celle que la fiche affiche)
    let target: { href: string; actions: { id: string; tenant_id: string; property_id: string }[] } | null = null;
    for (const href of hrefs.slice(0, 15)) {
      const { rows } = await c.query(`select a.id, a.tenant_id, a.property_id from revenue_actions a join opportunities o on o.id = a.opportunity_id where o.code = $1 and o.tenant_id = (select tenant_id from users where email = $2) and a.status <> 'CANCELLED'`, [decodeURIComponent(href.split("/").pop()!), process.env.E2E_EMAIL]);
      if (rows.length) { target = { href, actions: rows }; break; }
    }
    expect(target, "aucun dossier avec action dans l'historique").not.toBeNull();
    // les trois formats tournent en parallèle sur la même action : chacun pose sa propre ligne, repérable par son empreinte et son adresse
    const hash = (tag + stamp).padEnd(64, "a").slice(0, 64), endpoint = `/listings/fake-${tag}/overrides`;
    const snap = (price: string) => JSON.stringify({ readAt: "2026-11-23T10:00:00.000Z", currency: "EUR", pushEnabled: true, limits: { minCents: 8300, baseCents: 12000, maxCents: 25000 }, prices: {}, overrides: price ? [{ date: "2026-12-21", price, price_type: "fixed" }] : [] });
    for (const act of target!.actions) {
      const wid = `xw_e2e_${tag}_${stamp}_${act.id.slice(-6)}`; wids.push(wid);
      await c.query(
        `insert into external_writes (id, tenant_id, property_id, action_id, idempotency_key, phase, kind, status, plan, receipt, adapter, state_before, state_after, state_before_hash, state_after_hash)
         values ($1,$2,$3,$4,$5,'APPLY','OVERRIDES_SET','CONFIRMED',$6,$7,'FAKE',$8,$9,$10,$11)`,
        [wid, act.tenant_id, act.property_id, act.id, wid + ":APPLY", JSON.stringify({ kind: "OVERRIDES", items: [{ date: "2026-12-21", priceCents: 11000 }] }),
          JSON.stringify({ method: "POST", endpoint, status: 200, sentAt: "2026-11-23T10:00:01.000Z", requestHash: hash }), snap(""), snap("110"), "b".repeat(64), "c".repeat(64)]);
    }
    await page.goto(target!.href);
    await deplierDossier(page);
    const proof = page.getByTestId("write-proof");
    await expect(proof.getByRole("heading", { name: /Preuve d'écriture/ })).toBeVisible();
    const mine = proof.getByTestId("write-proof-item").filter({ hasText: endpoint });
    await expect(mine).toHaveCount(1);
    await expect(mine.getByText("Confirmée par relecture")).toBeVisible();
    await expect(mine.getByText(`POST ${endpoint} → 200`)).toBeVisible();
    await expect(mine.getByRole("row", { name: /Prix daté du/ })).toContainText(/110\s?€/);
    await expectNoHorizontalOverflow(page, "dossier avec preuve d'écriture");
    // le tableau lui-même ne défile pas non plus
    const scrolls = await mine.locator(".table-wrap").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(scrolls, "le tableau avant/après défile horizontalement").toBe(false);
    await proof.scrollIntoViewIfNeeded();
    await proof.screenshot({ path: info.outputPath("preuve-ecriture.png") });
    await info.attach("preuve-ecriture", { path: info.outputPath("preuve-ecriture.png"), contentType: "image/png" });
  } finally {
    for (const wid of wids) await c.query("delete from external_writes where id = $1", [wid]);
    await c.end();
  }
});

import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";
import { dossiersTranches } from "./helpers/dossier";

// US-094 : l'écran « Alertes » (pastille de menu, cartes, prise en compte) et le rappel sur la fiche du dossier, lisibles sans défilement horizontal sur les trois formats.
// Le jeu de test insère deux alertes sur une action de démonstration existante, puis les retire.
test("Alertes d'exécution : liste, pastille, prise en compte, rappel sur le dossier", async ({ page }, info) => {
  test.skip(!hasDatabase(), "Alertes insérées en base : DATABASE_URL requis.");
  const hrefs = await dossiersTranches(page);
  expect(hrefs.length).toBeGreaterThan(0);
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  const tag = info.project.name.replace(/\W/g, ""), stamp = Date.now().toString(36);
  const ids: string[] = [];
  await c.connect();
  try {
    await c.query("delete from execution_alerts where id like 'alr_e2e_%' and created_at < now() - interval '1 hour'"); // restes d'un arrêt brutal
    let target: { href: string; act: { id: string; tenant_id: string; property_id: string } } | null = null;
    for (const href of hrefs.slice(0, 15)) {
      const { rows } = await c.query(`select a.id, a.tenant_id, a.property_id from revenue_actions a join opportunities o on o.id = a.opportunity_id where o.code = $1 and o.tenant_id = (select tenant_id from users where email = $2) and a.status <> 'CANCELLED' limit 1`, [decodeURIComponent(href.split("/").pop()!), process.env.E2E_EMAIL]);
      if (rows.length) { target = { href, act: rows[0] }; break; }
    }
    expect(target, "aucun dossier avec action dans l'historique").not.toBeNull();
    const { act } = target!;
    const crit = `Écart critique ${tag} ${stamp}`, warn = `Refus à surveiller ${tag} ${stamp}`;
    for (const [kind, sev, title, withAction] of [["DRIFT", "CRITICAL", crit, true], ["WRITE_FAILED", "WARNING", warn, false]] as const) {
      const id = `alr_e2e_${tag}_${stamp}_${kind}`; ids.push(id);
      await c.query(
        `insert into execution_alerts (id, tenant_id, property_id, action_id, kind, severity, title, detail, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, act.tenant_id, withAction ? act.property_id : null, withAction ? act.id : null, kind, sev, title, "Le prix minimum chez PriceLabs est 105,00 € au lieu de 95,00 € : quelqu'un a peut-être modifié la grille dans PriceLabs.", id]);
    }
    await page.goto("/alertes");
    await expect(page.getByRole("heading", { name: "À traiter" })).toBeVisible();
    const card = (title: string) => page.getByTestId("alert-card").filter({ hasText: title });
    await expect(card(crit)).toBeVisible();
    await expect(card(crit)).toContainText("Critique");
    await expect(card(warn)).toContainText("À surveiller");
    await expect(card(crit).getByRole("link", { name: "Ouvrir le dossier" })).toBeVisible();
    await expect(page.locator('[aria-label*="à traiter"]:visible').first()).toBeVisible(); // pastille : colonne (bureau) ou bouton « Plus » (mobile)
    await expectNoHorizontalOverflow(page, "écran Alertes");
    await page.getByTestId("alert-card").first().screenshot({ path: info.outputPath("alerte.png") });
    await info.attach("alerte", { path: info.outputPath("alerte.png"), contentType: "image/png" });

    // prise en compte d'un écart : la carte passe dans « Prises en compte » et reste visible
    await card(crit).getByRole("button", { name: "Prendre en compte" }).click();
    await expect(card(crit)).toHaveAttribute("data-status", "ACKNOWLEDGED");
    await expect(page.getByRole("heading", { name: /Prises en compte/ })).toBeVisible();
    await expect(card(crit).getByRole("button", { name: "Prendre en compte" })).toHaveCount(0);
    // un refus certain pris en compte se referme : il rejoint « Résolues récemment »
    await card(warn).getByRole("button", { name: "Prendre en compte" }).click();
    await expect(card(warn)).toHaveAttribute("data-status", "RESOLVED");
    await expectNoHorizontalOverflow(page, "écran Alertes après prise en compte");

    // la fiche du dossier rappelle l'alerte de son action
    await page.goto(target!.href);
    await expect(page.getByTestId("dossier-alerts").getByText(crit)).toBeVisible();
    await expectNoHorizontalOverflow(page, "dossier avec alerte");
  } finally {
    for (const id of ids) await c.query("delete from execution_alerts where id = $1", [id]);
    await c.end();
  }
});

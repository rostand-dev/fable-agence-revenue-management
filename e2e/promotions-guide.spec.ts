import { expect, test } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";

// US-102 : guide pas-à-pas d'une action manuelle : étapes cochables, avancement conservé au rechargement, lisible sans défilement horizontal.
// Chaque largeur crée sa propre copie d'un dossier de démonstration dont l'action manuelle est « approuvée », puis la retire.
test.skip(!hasDatabase(), "DATABASE_URL absent : dossier de test non créable sur cet environnement");

async function withApprovedManualDossier(fn: (code: string) => Promise<void>) {
  const code = `E2E-${test.info().project.name.replace(/\W/g, "")}-${Date.now().toString(36)}`;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const oid = `opp_e2e_${Date.now().toString(36)}${test.info().parallelIndex}`, aid = `act_e2e_${Date.now().toString(36)}${test.info().parallelIndex}`;
  try {
    const src = await c.query(`select a.id aid, a.opportunity_id oid from revenue_actions a where a.simulation->>'executionMode' = 'MANUAL_RUNBOOK' and a.type = 'PROMO_REMOVAL' order by a.created_at limit 1`);
    expect(src.rowCount, "aucune action manuelle de démonstration à copier").toBe(1);
    await c.query(`create temp table o_copy as select * from opportunities where id = $1`, [src.rows[0].oid]);
    await c.query(`update o_copy set id = $1, code = $2`, [oid, code]);
    await c.query(`insert into opportunities select * from o_copy`);
    await c.query(`create temp table a_copy as select * from revenue_actions where id = $1`, [src.rows[0].aid]);
    await c.query(`update a_copy set id = $1, opportunity_id = $2, idempotency_key = $3, status = 'DRAFT', executed_at = null, execution = null, verified_at = null, measure_due_at = null, measurement = null`, [aid, oid, `e2e-${aid}`]);
    await c.query(`insert into revenue_actions select * from a_copy`);
    // une base de données exige que l'action naisse à l'état DRAFT puis suive la machine à états
    for (const st of ["SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED"]) await c.query(`update revenue_actions set status = $1 where id = $2`, [st, aid]);
    await fn(code);
  } finally {
    await c.query(`delete from opportunities where id = $1`, [oid]).catch(() => {});
    await c.end();
  }
}

test("Guide pas-à-pas : cocher, décocher, avancement conservé, sans débordement", async ({ page }) => {
  await withApprovedManualDossier(async (code) => {
    await page.goto(`/dossier/${code}`);
    const guide = page.getByTestId("runbook");
    await expect(guide).toBeVisible();
    const steps = guide.getByTestId("runbook-step");
    const total = await steps.count();
    expect(total).toBeGreaterThan(3);
    const progress = guide.getByTestId("runbook-progress");
    await expect(progress).toContainText(/^0 étape cochée sur \d+\./);
    await guide.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "guide pas-à-pas");

    const first = guide.locator('[data-step="open"]');
    await first.getByRole("button", { name: /Marquer comme faite/ }).click();
    await expect(first).toHaveAttribute("data-done", "true");
    await expect(progress).toContainText(/^1 étape cochée sur \d+/);
    await expect(first).toContainText("Faite par");

    // l'avancement est enregistré : il survit au rechargement
    await page.reload();
    await expect(page.getByTestId("runbook").locator('[data-step="open"]')).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("runbook-progress")).toContainText(/^1 étape cochée sur/);
    await expectNoHorizontalOverflow(page, "guide après rechargement");

    // décocher
    await page.getByTestId("runbook").locator('[data-step="open"]').getByRole("button", { name: /Annuler/ }).click();
    await expect(page.getByTestId("runbook-progress")).toContainText(/^0 étape cochée sur/);
    // la consigne de sécurité se lit mais ne se coche pas
    const stop = page.getByTestId("runbook").locator('[data-step="stop-if-different"]');
    await expect(stop).toBeVisible();
    await expect(stop.getByRole("button")).toHaveCount(0);
  });
});

test.describe("rôle sans droit d'exécution", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("Propriétaire du bien : le guide se lit (Faite / À faire) sans aucun bouton", async ({ page }) => {
    const u = await createRoleUser("OWNER_VIEWER", test.info().project.name.replace(/\W/g, "") + "-" + Date.now().toString(36));
    try {
      await withApprovedManualDossier(async (code) => {
        await page.goto("/connexion");
        await page.getByLabel("Adresse e-mail").fill(u.email);
        await page.getByLabel("Mot de passe").fill(u.password);
        await page.getByRole("button", { name: "Se connecter" }).click();
        await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
        await page.goto(`/dossier/${code}`);
        await expect(page.getByTestId("execution-reservee")).toBeVisible();
        const guide = page.getByTestId("runbook");
        await expect(guide).toBeVisible();
        await expect(guide.getByRole("button")).toHaveCount(0);
        await expect(guide.getByText("À faire").first()).toBeVisible();
        await guide.scrollIntoViewIfNeeded();
        await expectNoHorizontalOverflow(page, "guide en lecture seule");
      });
    } finally { await deleteUser(u.id); }
  });
});

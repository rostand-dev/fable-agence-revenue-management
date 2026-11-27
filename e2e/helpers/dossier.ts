import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Dossier de test à action manuelle « approuvée » : copie d'un dossier de démonstration, retirée à la fin.
 * Chaque largeur (projet Playwright) a sa propre copie : les tests en parallèle ne se heurtent pas.
 * La promotion visée par la copie est une promotion jetable, créée pour le test : confirmer l'action ne touche aucune promotion de démonstration.
 */
export async function withApprovedManualDossier(fn: (code: string) => Promise<void>) {
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
    // promotion jetable (copie d'une promotion du même tenant), seule visée par l'action copiée
    const pid = `promo_e2e_${aid}`;
    const pr = await c.query(`select 1 from promotions limit 1`);
    expect(pr.rowCount, "aucune promotion de démonstration à copier").toBe(1);
    await c.query(`create temp table p_copy as select * from promotions where id = (select id from promotions order by created_at limit 1)`);
    await c.query(`update p_copy set id = $1, status = 'ACTIVE', ended_at = null, end_reason = null, action_id = null`, [pid]);
    await c.query(`insert into promotions select * from p_copy`);
    await c.query(`create temp table a_copy as select * from revenue_actions where id = $1`, [src.rows[0].aid]);
    await c.query(`update a_copy set id = $1, opportunity_id = $2, idempotency_key = $3, status = 'DRAFT', executed_at = null, execution = null, verified_at = null, measure_due_at = null, measurement = null, parameters = jsonb_set(parameters, '{promotionId}', to_jsonb($4::text))`, [aid, oid, `e2e-${aid}`, pid]);
    await c.query(`insert into revenue_actions select * from a_copy`);
    // une base de données exige que l'action naisse à l'état DRAFT puis suive la machine à états
    for (const st of ["SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED"]) await c.query(`update revenue_actions set status = $1 where id = $2`, [st, aid]);
    await fn(code);
  } finally {
    await c.query(`delete from execution_alerts where action_id = $1`, [aid]).catch(() => {});
    await c.query(`delete from promotions where id = $1`, [`promo_e2e_${aid}`]).catch(() => {});
    await c.query(`delete from opportunities where id = $1`, [oid]).catch(() => {});
    await c.end();
  }
}

/**
 * En mode poche (largeurs de téléphone), les sections d'un dossier sont repliées : les ouvrir, d'un toucher, avant de les vérifier.
 * Sans effet sur la version complète. À rappeler après un rechargement.
 */
export async function deplierDossier(page: Page): Promise<void> {
  // le dossier est affiché : écran de décision, ou frise de la version complète
  await expect(page.locator('[data-testid="dossier-decision"], ol.frieze').first()).toBeAttached();
  const plis = page.locator(".pk-folds > details.pk-fold");
  for (let i = 0; i < (await plis.count()); i++) {
    const pli = plis.nth(i);
    if (!(await pli.evaluate((d: HTMLDetailsElement) => d.open))) await pli.locator(":scope > summary").click();
    await expect(pli).toHaveAttribute("open", "");
  }
}

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
    // source : un original de l'espace du compte de démo, jamais la copie d'un autre test (même date que sa source, supprimée en parallèle)
    const espace = (await c.query(`select tenant_id from users where email = $1`, [process.env.E2E_EMAIL])).rows[0]?.tenant_id as string | undefined;
    expect(espace, "compte de démo introuvable").toBeTruthy();
    const src = await c.query(`select a.id aid, a.opportunity_id oid from revenue_actions a join opportunities o on o.id = a.opportunity_id where o.tenant_id = $1 and not starts_with(a.id, 'act_e2e_') and a.simulation->>'executionMode' = 'MANUAL_RUNBOOK' and a.type = 'PROMO_REMOVAL' order by a.created_at, a.id limit 1`, [espace]);
    expect(src.rowCount, "aucune action manuelle de démonstration à copier").toBe(1);
    await c.query(`create temp table o_copy as select * from opportunities where id = $1`, [src.rows[0].oid]);
    await c.query(`update o_copy set id = $1, code = $2`, [oid, code]);
    const copie = async (table: string, depuis: string) => expect((await c.query(`insert into ${table} select * from ${depuis}`)).rowCount, `copie de test non créée dans ${table}`).toBe(1);
    await copie("opportunities", "o_copy");
    // promotion jetable (copie d'une promotion du même tenant), seule visée par l'action copiée
    const pid = `promo_e2e_${aid}`;
    await c.query(`create temp table p_copy as select * from promotions where false`);
    await c.query(`insert into p_copy select * from promotions where tenant_id = $1 and not starts_with(id, 'promo_e2e_') order by created_at, id limit 1`, [espace]);
    await c.query(`update p_copy set id = $1, status = 'ACTIVE', ended_at = null, end_reason = null, action_id = null`, [pid]);
    await copie("promotions", "p_copy");
    await c.query(`create temp table a_copy as select * from revenue_actions where id = $1`, [src.rows[0].aid]);
    await c.query(`update a_copy set id = $1, opportunity_id = $2, idempotency_key = $3, status = 'DRAFT', executed_at = null, execution = null, verified_at = null, measure_due_at = null, measurement = null, parameters = jsonb_set(parameters, '{promotionId}', to_jsonb($4::text))`, [aid, oid, `e2e-${aid}`, pid]);
    await copie("revenue_actions", "a_copy");
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

/**
 * Adresses des dossiers de démonstration tranchés (codes « S-… »), lues dans l'historique de la version complète, sans changer le mode de la page :
 * en mode poche, l'historique ne montre que les dix dernières décisions, que les copies des tests en parallèle peuvent toutes occuper.
 */
export async function dossiersTranches(page: Page): Promise<string[]> {
  const res = await page.request.get("/historique", { headers: { "Sec-CH-UA-Mobile": "?0" } });
  expect(res.status(), "historique en version complète").toBe(200);
  return Array.from(new Set(Array.from((await res.text()).matchAll(/href="(\/dossier\/S-[^"?#]+)"/g), (m) => m[1])));
}

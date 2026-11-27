import { expect, test } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { deplierDossier, withApprovedManualDossier } from "./helpers/dossier";
import { hasDatabase } from "./helpers/roles";
import { versionComplete } from "./helpers/view";

// US-111 : résultat d'une expérience (positif, neutre, négatif ou non concluant), motifs, méthode. Trois largeurs, sans débordement.
test.skip(!hasDatabase(), "DATABASE_URL absent : dossier de test non créable sur cet environnement");

/** Referme l'action du dossier de test comme le ferait le planificateur, avec le résultat voulu. */
async function closeWith(code: string, measurement: Record<string, unknown>) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { rows } = await c.query(`select a.id from revenue_actions a join opportunities o on o.id = a.opportunity_id where o.code = $1`, [code]);
    const id = rows[0].id as string;
    for (const st of ["EXECUTING", "EXECUTED", "VERIFIED", "MEASURING", "CLOSED"]) await c.query(`update revenue_actions set status = $1 where id = $2`, [st, id]);
    await c.query(`update revenue_actions set measurement = $1::jsonb, executed_at = now(), verified_at = now(), measure_due_at = current_date where id = $2`, [JSON.stringify(measurement), id]);
  } finally { await c.end(); }
}
const base = { incrementalCents: null, confidence: "faible", measuredAt: new Date().toISOString() };

for (const [outcome, label, reasons] of [
  ["POSITIVE", "Positif", []],
  ["NEUTRAL", "Neutre", ["PRICE_DILUTION"]],
  ["NEGATIVE", "Négatif", []],
  ["INCONCLUSIVE", "Non concluant", ["RESERVATIONS_STALE", "OVERLAPPING_ACTION"]],
] as const) {
  test(`Dossier : résultat « ${label} » affiché avec ses motifs, sans effet attribué`, async ({ page }) => {
    await withApprovedManualDossier(async (code) => {
      await closeWith(code, { ...base, outcome, reasons, observed: `Observation de test (${outcome}).`, interpretation: "Sans période témoin, ce résultat décrit ce qui s'est passé après l'action ; il ne prouve pas qu'elle en soit la cause." });
      await page.goto(`/dossier/${code}`);
      await deplierDossier(page); // action refermée : le suivi d'application est replié
      const r = page.getByTestId("resultat-mesure");
      await expect(r).toBeVisible();
      await expect(r).toHaveAttribute("data-outcome", outcome);
      await expect(r).toContainText(label);
      if (outcome === "POSITIVE") await expect(r).toContainText("corrélation, pas causalité");
      if (reasons.length) await expect(page.getByTestId("motifs-mesure").locator("li")).toHaveCount(reasons.length);
      else await expect(page.getByTestId("motifs-mesure")).toHaveCount(0);
      await expect(page.getByText("Observation de test").first()).toBeVisible();
      await expect(page.getByText("Aucune période témoin comparable").first()).toBeVisible();
      await r.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page, `dossier mesuré (${outcome})`);
    });
  });
}

test("Historique : les quatre résultats sont comptés, la mesure d'une action refermée est lisible", async ({ page }) => {
  await page.goto("/historique");
  await expect(page.getByText(/négative\(s\)/).first()).toBeVisible();
  await expect(page.getByText(/non concluante\(s\)/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "historique");
});

test("Méthode : la lecture d'un résultat est expliquée (seuils, dilution, non concluant)", async ({ page }) => {
  await versionComplete(page.context()); // écran réservé à l'ordinateur
  await page.goto("/methode");
  const s = page.getByTestId("methode-mesure");
  await s.scrollIntoViewIfNeeded();
  await expect(s).toContainText("Comment une action est mesurée");
  await expect(s).toContainText("Non concluant");
  await expect(s).toContainText("Dilution");
  await expect(s).toContainText("Aucune période témoin");
  await expectNoHorizontalOverflow(page, "méthode");
});

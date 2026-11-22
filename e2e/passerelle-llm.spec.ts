import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-070 : la carte « Modèle de langage » de la page Intégrations indique le fournisseur, la clé et le repli en cas de panne.
// Bureau, mobile 390 et 360 px, sur le compte de démo (aucune clé : mode déterministe, aucun repli configuré en CI).
test("Intégrations : la carte du modèle de langage affiche le fournisseur principal et le repli, sans débordement", async ({ page }) => {
  await page.goto("/integrations");
  const carte = page.locator("article.stratum", { has: page.getByRole("heading", { name: "Modèle de langage" }) });
  await expect(carte).toBeVisible();
  await expect(carte).toContainText("Fournisseur");
  await expect(carte).toContainText("Anthropic");
  await expect(carte).toContainText("Repli en cas de panne");
  await expect(carte).toContainText("aucun fournisseur de repli");
  await expectNoHorizontalOverflow(page, "intégrations : modèle de langage");
  await carte.scrollIntoViewIfNeeded();
  await carte.screenshot({ path: test.info().outputPath("llm-carte.png") });
  await test.info().attach("llm-carte", { path: test.info().outputPath("llm-carte.png"), contentType: "image/png" });
});

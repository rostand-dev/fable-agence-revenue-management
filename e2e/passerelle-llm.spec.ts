import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// Routeur LLM : la carte « Modèles de langage » de la page Intégrations propose une clé par fournisseur (Anthropic, OpenAI, Mistral), saisie par le propriétaire.
// Le serveur ne détient aucune clé : sur le compte de démo de la CI, seule la clé Anthropic factice est enregistrée (DEMO_ACCOUNT_LLM_KEY, faux serveur de modèle).
// Bureau, mobile 390 et 360 px.
test("Intégrations : la carte des modèles de langage propose une clé par fournisseur, sans débordement", async ({ page }) => {
  await page.goto("/integrations");
  const carte = page.locator("article.stratum", { has: page.getByRole("heading", { name: "Modèles de langage" }) });
  await expect(carte).toBeVisible();
  await expect(carte).toContainText("propre clé");
  for (const [p, label] of [["anthropic", "Anthropic"], ["openai", "OpenAI"], ["mistral", "Mistral"]] as const) {
    const s = carte.locator(`section[data-provider="${p}"]`);
    await expect(s).toBeVisible();
    await expect(s.getByRole("heading", { name: new RegExp(label) })).toBeVisible();
    await expect(s.locator(`input[name="apiKey"]`)).toBeVisible();
  }
  // compte de démo de la CI : clé Anthropic enregistrée (factice) ; les autres fournisseurs sont modifiés par le test suivant (état partagé entre les 3 formats d'écran : on ne l'assert pas ici)
  await expect(carte.locator('section[data-provider="anthropic"]')).toContainText("Votre clé");
  await expectNoHorizontalOverflow(page, "intégrations : modèles de langage");
  await carte.scrollIntoViewIfNeeded();
  await carte.screenshot({ path: test.info().outputPath("llm-carte.png") });
  await test.info().attach("llm-carte", { path: test.info().outputPath("llm-carte.png"), contentType: "image/png" });
});

// Saisie d'une clé : vérifiée auprès du faux serveur (liste de modèles), enregistrée chiffrée, jamais réaffichée en entier ; puis supprimée.
// Les trois formats d'écran partagent le compte de démo : chacun utilise son propre fournisseur pour ne pas se marcher dessus (le 360 px n'en a pas, il est couvert par la lecture ci-dessus).
const PROVIDER_BY_PROJECT: Record<string, "openai" | "mistral"> = { bureau: "openai", "mobile-390": "mistral" };
test("Intégrations : saisir puis supprimer une clé de fournisseur", async ({ page }, info) => {
  const provider = PROVIDER_BY_PROJECT[info.project.name];
  test.skip(!provider, "ce format d'écran n'a pas de fournisseur dédié");
  const key = `sk-e2e-${provider}-0123456789abcdef`;
  await page.goto("/integrations");
  const s = page.locator(`section[data-provider="${provider}"]`);
  await s.locator('input[name="apiKey"]').fill(key);
  await s.getByRole("button", { name: /Vérifier et enregistrer/ }).click();
  await expect(s).toContainText("Votre clé", { timeout: 20_000 });
  await expect(s).not.toContainText(key);
  await expectNoHorizontalOverflow(page, `intégrations : clé ${provider} enregistrée`);
  await s.getByRole("button", { name: /Supprimer ma clé/ }).click();
  await expect(page.locator(`section[data-provider="${provider}"]`)).toContainText("Pas de clé", { timeout: 20_000 });
});

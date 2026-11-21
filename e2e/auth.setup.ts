import { expect, test as setup } from "@playwright/test";

// Se connecte une fois avec le compte de démo et garde la session pour tous les autres tests.
// L'application répond « saine » avant d'avoir fini de créer le compte de démo (créé juste après les migrations) : on réessaie donc la connexion quelques secondes.
setup("connexion du compte de démo", async ({ page }) => {
  const email = process.env.E2E_EMAIL, password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("E2E_EMAIL et E2E_PASSWORD sont obligatoires (compte de démo de l'environnement testé).");
  setup.setTimeout(90_000);
  let connecte = false;
  for (let essai = 1; essai <= 15 && !connecte; essai++) {
    await page.goto("/connexion");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    connecte = await page.waitForURL((u) => !u.pathname.startsWith("/connexion"), { timeout: 5_000 }).then(() => true, () => false);
    if (!connecte) await page.waitForTimeout(2_000);
  }
  expect(connecte, "connexion impossible avec le compte de démo (compte non créé ou identifiants E2E_EMAIL / E2E_PASSWORD incorrects)").toBe(true);
  await page.context().storageState({ path: "e2e/.auth/state.json" });
});

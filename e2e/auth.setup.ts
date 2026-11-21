import { expect, test as setup } from "@playwright/test";

// Se connecte une fois avec le compte de démo et garde la session pour tous les autres tests.
// L'application répond « saine » avant d'avoir fini de créer le compte de démo (créé juste après les migrations) : on réessaie donc la connexion quelques secondes.
setup("connexion du compte de démo", async ({ page }) => {
  const email = process.env.E2E_EMAIL, password = process.env.E2E_PASSWORD;
  if (!email || !password) throw new Error("E2E_EMAIL et E2E_PASSWORD sont obligatoires (compte de démo de l'environnement testé).");
  setup.setTimeout(90_000);
  let connecte = false, statut = 0, message = "";
  for (let essai = 1; essai <= 8 && !connecte; essai++) {
    const res = await page.goto("/connexion");
    statut = res?.status() ?? 0;
    if (statut >= 400) { await page.waitForTimeout(3_000); continue; } // 401 : identifiants HTTP de la preview refusés ; 5xx : application indisponible
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    connecte = await page.waitForURL((u) => !u.pathname.startsWith("/connexion"), { timeout: 5_000 }).then(() => true, () => false);
    if (!connecte) {
      // Message affiché par l'application (jamais un identifiant) : permet de distinguer mauvais identifiants et application en difficulté.
      message = (await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).join(" | ").slice(0, 300);
      await page.waitForTimeout(2_000);
    }
  }
  const diagnostic = statut === 401
    ? "la preview a refusé les identifiants HTTP (secrets PREVIEW_BASIC_AUTH_USER / PREVIEW_BASIC_AUTH_PASSWORD différents de ceux de Coolify)"
    : statut >= 400
      ? `la page de connexion répond HTTP ${statut}`
      : `la connexion est refusée par l'application${message ? ` (message affiché : « ${message} »)` : ""} : compte de démo absent (DEMO_ACCOUNT_* du groupe Preview Deployment dans Coolify, domaine autorisé) ou identifiants PREVIEW_DEMO_* incorrects`;
  expect(connecte, `connexion impossible : ${diagnostic}`).toBe(true);
  await page.context().storageState({ path: "e2e/.auth/state.json" });
});

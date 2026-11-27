import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase, markLaunched, removeProperty } from "./helpers/roles";
import { versionComplete } from "./helpers/view";

// US-084 : un rôle sans droit lit les dossiers mais ne peut ni approuver, ni rejeter, ni différer ; le serveur refuse aussi (403).
// Les comptes de test vivent dans l'espace du compte de démo ; ils exigent DATABASE_URL (ignorés sur une Preview distante).
test.skip(!hasDatabase(), "DATABASE_URL absent : comptes de rôles non créables sur cet environnement");
test.use({ storageState: { cookies: [], origins: [] } });

async function login(page: Page, u: { email: string; password: string }) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(u.email);
  await page.getByLabel("Mot de passe").fill(u.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
}
const tag = () => test.info().project.name.replace(/\W/g, "") + "-" + test.info().parallelIndex + "-" + Date.now().toString(36);
/** Un logement réel de l'espace de démo, créé par un administrateur (seuls certains rôles peuvent en créer). */
async function createPropertyAs(browser: Browser, admin: { email: string; password: string }, name: string): Promise<string> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const p = await ctx.newPage();
    await login(p, admin);
    const created = await p.request.post("/api/v1/properties", { data: { name, city: "Lille", kind: "T2", bedrooms: 1 } });
    expect(created.ok(), await created.text()).toBe(true);
    return (await created.json()).id;
  } finally { await ctx.close(); }
}
/** Boutons d'envoi encore actifs dans le contenu de l'écran (hors déconnexion) : sans le droit, il ne doit en rester aucun. */
const activeSubmits = (page: Page) => page.locator('.content form button:not([type="button"]):enabled').evaluateAll((bs) => bs.map((b) => b.textContent?.trim() ?? "").filter((t) => t !== "Se déconnecter partout"));
async function shot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
}
const dossierHrefs = (page: Page) => page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));

test("Analyste : lecture seule dans la boîte d'opportunités, le dossier et l'historique", async ({ page }) => {
  await versionComplete(page.context()); // passe par des écrans réservés à l'ordinateur
  const u = await createRoleUser("ANALYST", tag());
  try {
    await login(page, u);
    await expect(page.getByTestId("lecture-seule")).toContainText("Votre rôle (Analyste) ne permet pas de décider");
    await expect(page.getByRole("button", { name: /^Approuver$|Retenir l'inaction|Différer/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "Inbox en lecture seule");

    const hrefs = await dossierHrefs(page);
    expect(hrefs.length, "aucun dossier dans la démonstration").toBeGreaterThan(0);
    await page.goto(hrefs[0]);
    await expect(page.getByTestId("lecture-seule")).toBeVisible();
    await expect(page.getByRole("button", { name: /Approuver|Rejeter la proposition|Retenir l'inaction|Différer/ })).toHaveCount(0);
    await page.getByTestId("lecture-seule").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "dossier en lecture seule");
    // US-083 : sans droit de lecture du journal, la traçabilité est refusée et ne fuit aucun événement
    await expect(page.getByTestId("trace-audit")).toContainText(/ne permet pas|réservé/i);
    await expect(page.getByTestId("trace-audit").locator("ol.trace-list")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("analyste-dossier.png") });
    await test.info().attach("analyste-dossier", { path: test.info().outputPath("analyste-dossier.png"), contentType: "image/png" });

    await page.goto("/historique#journal");
    await expect(page.getByTestId("journal-reserve")).toContainText("Journal réservé");
    await expectNoHorizontalOverflow(page, "historique sans journal");

    await page.goto("/parametres/compte#droits");
    const droits = page.getByTestId("droits");
    await expect(droits).toContainText("Analyste");
    await expect(droits.getByRole("row", { name: /Approuver, rejeter/ })).toContainText("Non autorisé");
    await expect(droits.getByRole("row", { name: /Supprimer un logement/ })).toContainText("Non autorisé");
    // la réponse tient dans le tableau, sans défilement latéral
    expect(await droits.locator(".table-wrap").evaluate((el) => el.scrollWidth - el.clientWidth), "tableau des droits coupé").toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page, "compte : droits");

    await page.goto("/parametres/demo");
    await expect(page.locator(".content")).toContainText("La réinstallation est réservée au propriétaire du compte et à l'administrateur.");
    await expect(page.getByRole("button", { name: /Réinstaller la démonstration/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "démonstration en lecture seule");
  } finally { await deleteUser(u.id); }
});

test("Analyste : le serveur refuse l'approbation par l'API (403) et le journal d'audit (403)", async ({ page }) => {
  const u = await createRoleUser("ANALYST", tag());
  try {
    await login(page, u);
    const res = await page.request.post("/api/v1/opportunities/opp_inexistant/approve", { data: { candidate: 0, comment: "Test de refus" } });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    const rej = await page.request.post("/api/v1/opportunities/opp_inexistant/reject", { data: {} });
    expect(rej.status()).toBe(403);
    const audit = await page.request.get("/api/audit-events?limit=5");
    expect(audit.status()).toBe(403);
  } finally { await deleteUser(u.id); }
});

test("Auditeur : lit le journal d'audit, sans aucun bouton de décision", async ({ page }) => {
  const u = await createRoleUser("AUDITOR", tag());
  try {
    await login(page, u);
    await expect(page.getByRole("button", { name: /^Approuver$|Retenir l'inaction|Différer/ })).toHaveCount(0);
    await page.goto("/historique#journal");
    await expect(page.getByTestId("journal-reserve")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Journal d'audit" })).toBeVisible();
    await expect(page.locator("ul.timeline").last().locator("li").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "journal de l'auditeur");
    expect((await page.request.get("/api/audit-events?limit=5")).status()).toBe(200);
  } finally { await deleteUser(u.id); }
});

test("Revenue manager : décide comme le propriétaire du compte (non-régression)", async ({ page }) => {
  const u = await createRoleUser("REVENUE_MANAGER", tag());
  try {
    await login(page, u);
    await expect(page.getByTestId("lecture-seule")).toHaveCount(0);
    const hrefs = await dossierHrefs(page);
    expect(hrefs.length).toBeGreaterThan(0);
    await page.goto(hrefs[0]);
    await expect(page.getByTestId("lecture-seule")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rejeter la proposition" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "dossier du revenue manager");
  } finally { await deleteUser(u.id); }
});

// La suppression d'un logement est définitive : seuls le propriétaire du compte et l'administrateur la voient et l'obtiennent.
for (const role of ["ANALYST", "REVENUE_MANAGER"] as const) {
  test(`Suppression d'un logement : ${role} n'a ni lien ni formulaire, le serveur refuse ; l'administrateur supprime`, async ({ page, browser }) => {
    await versionComplete(page.context()); // passe par des écrans réservés à l'ordinateur
    test.setTimeout(90_000); // deux connexions, six écrans et une suppression
    const name = `Droits ${role} ${tag()}`, users: string[] = [];
    let propertyId: string | null = null;
    try {
      const u = await createRoleUser(role, tag()); users.push(u.id);
      const admin = await createRoleUser("TENANT_ADMIN", tag()); users.push(admin.id);
      const id = await createPropertyAs(browser, admin, name);
      propertyId = id;
      await login(page, u);
      const manages = role === "REVENUE_MANAGER";
      const links = page.locator(`a[href="/logements/${id}/supprimer"]`);

      // brouillon : la bannière propose de reprendre à qui gère les logements, jamais de supprimer
      await page.goto(`/logements/${id}`);
      await expect(page.getByText("Ce logement n'est pas encore lancé.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Reprendre la création" })).toHaveCount(manages ? 1 : 0);
      await expect(links).toHaveCount(0);

      await markLaunched(id);
      await page.goto(`/logements/${id}`);
      const others = page.getByRole("list", { name: "Autres écrans du logement" });
      await expect(others.getByRole("link", { name: "Historique du logement" })).toBeVisible();
      await expect(others.getByRole("link", { name: "Modifier le dossier" })).toHaveCount(manages ? 1 : 0);
      await expect(links).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "fiche sans suppression");
      await page.goto(`/logements/${id}/modifier`);
      if (manages) await expect(page.getByRole("heading", { name: `Dossier de ${name}` })).toBeVisible();
      else await expect(page.getByTestId("reserve")).toContainText("ne permet pas de gérer les logements");
      await expect(links).toHaveCount(0);
      await page.goto(`/logements/${id}/supprimer`);
      await expect(page.getByTestId("suppression-reservee")).toContainText("ne permet pas de supprimer un logement");
      await expect(page.getByRole("button", { name: "Supprimer définitivement" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "suppression réservée");
      await page.screenshot({ path: test.info().outputPath("suppression-reservee.png"), fullPage: true });
      await test.info().attach("suppression-reservee", { path: test.info().outputPath("suppression-reservee.png"), contentType: "image/png" });

      const res = await page.request.delete(`/api/v1/properties/${id}`, { data: { confirmName: name } });
      expect(res.status()).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
      expect((await page.request.get(`/api/v1/properties/${id}`)).status()).toBe(200);

      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        await versionComplete(ctx);
        const p2 = await ctx.newPage();
        await login(p2, admin);
        await p2.goto(`/logements/${id}`);
        await expect(p2.getByRole("list", { name: "Autres écrans du logement" }).getByRole("link", { name: "Supprimer le logement" })).toBeVisible();
        await p2.goto(`/logements/${id}/supprimer`);
        await p2.getByLabel(/Pour confirmer/).fill(name);
        await p2.getByRole("button", { name: "Supprimer définitivement" }).click();
        await p2.waitForURL(/\/logements\?supprime=1/);
      } finally { await ctx.close(); }
      expect((await page.request.get(`/api/v1/properties/${id}`)).status()).toBe(404);
    } finally {
      if (propertyId) await removeProperty(propertyId);
      for (const id of users) await deleteUser(id);
    }
  });
}

// Écritures hors circuit de décision : les logements (propriétaire, administrateur, revenue manager) et les réglages de l'espace
// (propriétaire, administrateur). Les écrans restent lisibles ; les champs sont verrouillés et le serveur refuse.
test("Analyste : écrans de saisie réservés, formulaires verrouillés avec explication, API refusée", async ({ page, browser }) => {
  await versionComplete(page.context()); // passe par des écrans réservés à l'ordinateur
  test.setTimeout(150_000); // une vingtaine d'écrans
  const name = `Lecture ${tag()}`, users: string[] = [];
  let propertyId: string | null = null;
  try {
    const u = await createRoleUser("ANALYST", tag()); users.push(u.id);
    const admin = await createRoleUser("TENANT_ADMIN", tag()); users.push(admin.id);
    const id = await createPropertyAs(browser, admin, name);
    propertyId = id;
    await login(page, u);

    // création d'un logement : aucun lien proposé, l'adresse directe explique
    await page.goto("/logements");
    await expect(page.getByRole("heading", { name: "Vos logements" })).toBeVisible();
    await expect(page.locator('a[href="/logements/nouveau"]')).toHaveCount(0);
    await expect(page.locator(".content").getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", `/logements/${id}`);
    await expect(page.getByText("Reprendre la création")).toHaveCount(0);
    for (const url of ["/logements/nouveau", `/logements/${id}/creation`]) {
      await page.goto(url);
      await expect(page.getByTestId("reserve")).toContainText("Votre rôle (Analyste) ne permet pas de gérer les logements");
      await expect(page.locator("main input, main select, main textarea")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, url);
    }
    await shot(page, "creation-reservee");

    await markLaunched(id);
    for (const url of [`/logements/${id}/couts`, `/logements/${id}/modifier`]) {
      await page.goto(url);
      await expect(page.getByTestId("reserve")).toContainText("Rôles qui le peuvent : propriétaire du compte, administrateur, revenue manager.");
      await expect(page.locator(".content input, .content select, .content textarea")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, url);
    }

    const screens: [string, string][] = [
      ...["?tab=annonces", "?tab=pricelabs", "?tab=superhote", "/strategie", "/saisons", "/qualite", "/validations", "/mapping"].map((x): [string, string] => [`/logements/${id}${x}`, "gérer les logements"]),
      ["/proprietaires", "gérer les logements"], ["/integrations", "gérer les logements"], ["/integrations/erreurs", "gérer les logements"],
      ["/modeles/cles", "régler l'espace"], ["/modeles/agents", "régler l'espace"], ["/modeles/budget", "régler l'espace"], ["/parametres/priorisation", "régler l'espace"],
    ];
    for (const [url, why] of screens) {
      await page.goto(url);
      await expect(page.locator(".rights-notice").first(), url).toContainText(`ne permet pas de ${why}`);
      expect(await activeSubmits(page), `bouton actif sur ${url}`).toEqual([]);
      await expect(page.locator(".content form fieldset.locked input:not([type=hidden]):enabled"), url).toHaveCount(0);
      await expectNoHorizontalOverflow(page, url);
    }
    await page.goto("/parametres/compte");
    await expect(page.locator(".rights-notice")).toHaveCount(2); // réglages de l'espace, puis fonctions des logements
    await expect(page.getByLabel("Nom de l'espace")).toBeDisabled();
    expect(await activeSubmits(page)).toEqual([]);
    await expect(page.getByRole("button", { name: "Se déconnecter partout" })).toBeEnabled();
    await shot(page, "compte-analyste");
    await page.goto("/modeles/budget");
    await expect(page.getByLabel("Plafond mensuel (€)")).toBeDisabled();
    await shot(page, "budget-analyste");
    await page.goto(`/logements/${id}?tab=pricelabs`);
    await shot(page, "pricelabs-analyste");

    // le serveur refuse aussi, quelle que soit l'interface
    const calls = [
      page.request.post("/api/v1/properties", { data: { name: "Refusé", city: "Lille", kind: "T2" } }),
      page.request.patch(`/api/v1/properties/${id}`, { data: { name: "Refusé" } }),
      page.request.post(`/api/v1/properties/${id}/listings`, { data: { channel: "AIRBNB" } }),
      page.request.post("/api/v1/owners", { data: { name: "Refusé" } }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status(), res.url()).toBe(403);
    expect((await (await page.request.get(`/api/v1/properties/${id}`)).json()).name).toBe(name);
  } finally {
    if (propertyId) await removeProperty(propertyId);
    for (const x of users) await deleteUser(x);
  }
});

test("Revenue manager : gère les logements, mais les réglages de l'espace restent verrouillés", async ({ page }) => {
  await versionComplete(page.context()); // passe par des écrans réservés à l'ordinateur
  test.setTimeout(90_000);
  const u = await createRoleUser("REVENUE_MANAGER", tag()), name = `Bailleur ${tag()}`;
  try {
    await login(page, u);
    await page.goto("/logements");
    await expect(page.locator('.content a[href="/logements/nouveau"]')).toBeVisible();

    await page.goto("/proprietaires");
    await expect(page.locator(".rights-notice")).toHaveCount(0);
    await expect(page.locator("fieldset.locked")).toHaveCount(0);
    const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Ajouter le propriétaire" }) });
    await create.getByLabel(/^Nom/).fill(name);
    await create.getByRole("button", { name: "Ajouter le propriétaire" }).click();
    await expect(page.getByText("Propriétaire ajouté.")).toBeVisible();
    const owner = ((await (await page.request.get("/api/v1/owners")).json()).owners as { id: string; name: string }[]).find((o) => o.name === name)!;
    expect((await page.request.delete(`/api/v1/owners/${owner.id}`)).status()).toBe(200);

    for (const url of ["/modeles/agents", "/modeles/budget", "/parametres/priorisation"]) {
      await page.goto(url);
      await expect(page.locator(".rights-notice").first(), url).toContainText("Votre rôle (Revenue manager) ne permet pas de régler l'espace");
      expect(await activeSubmits(page), url).toEqual([]);
      await expectNoHorizontalOverflow(page, url);
    }
    await page.goto("/parametres/compte");
    await expect(page.getByLabel("Nom de l'espace")).toBeDisabled();
    await expect(page.locator(".rights-notice")).toHaveCount(1);
    await expect(page.locator("form.flag-form button").first()).toBeEnabled();
    const droits = page.getByTestId("droits");
    await expect(droits.getByRole("row", { name: /Gérer les logements/ })).toContainText("Autorisé");
    await expect(droits.getByRole("row", { name: /Régler l'espace/ })).toContainText("Non autorisé");
    expect(await droits.locator(".table-wrap").evaluate((el) => el.scrollWidth - el.clientWidth), "tableau des droits coupé").toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page, "compte du revenue manager");
    await shot(page, "compte-revenue-manager");
  } finally { await deleteUser(u.id); }
});

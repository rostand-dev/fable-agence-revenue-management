import { randomBytes, scryptSync } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";

/**
 * Mode poche (version allégée sur téléphone) : détection, bascule, feuille « Plus », écrans réservés à l'ordinateur, coupe-circuit.
 * Les captures sont jointes aux résultats (sur la Preview : artefact « preview-smoke-captures »).
 */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const encart = (page: Page) => page.getByTestId("ecran-ordinateur");
const capture = (page: Page, nom: string) => page.screenshot({ path: test.info().outputPath(`${nom}.png`), animations: "disabled" });
const cookie = async (page: Page, name: string) => (await page.context().cookies()).find((c) => c.name === name);
const sheet = (page: Page) => page.locator("dialog.nav-sheet");
/** Ouvre la feuille « Plus » de la barre basse (le premier toucher peut précéder l'activation de la page : on réessaie). */
async function ouvrirPlus(page: Page) {
  await expect(async () => {
    if (!(await sheet(page).isVisible())) await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: /Plus/ }).click({ timeout: 2_000 });
    await expect(sheet(page)).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

test.describe("Détection de l'appareil", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "bureau", "indépendant de la largeur : une seule passe"));
  const cas: [string, Record<string, string>, boolean][] = [
    ["iPhone", { "User-Agent": IPHONE }, true],
    ["ordinateur", { "User-Agent": DESKTOP }, false],
    ["iPad", { "User-Agent": IPAD }, false],
    ["tablette Android", { "User-Agent": ANDROID_TABLET }, false],
    ["indice « téléphone », User-Agent d'ordinateur", { "User-Agent": DESKTOP, "Sec-CH-UA-Mobile": "?1" }, true],
    ["indice « pas un téléphone », User-Agent d'iPhone", { "User-Agent": IPHONE, "Sec-CH-UA-Mobile": "?0" }, false],
  ];
  for (const [nom, headers, poche] of cas) {
    test(`${nom} : version ${poche ? "allégée" : "complète"}`, async ({ request }) => {
      const res = await request.get("/modeles/cles", { headers });
      expect(res.status()).toBe(200);
      expect(res.headers()["accept-ch"]).toContain("Sec-CH-UA-Mobile");
      expect((await res.text()).includes('data-testid="ecran-ordinateur"')).toBe(poche);
    });
  }
  test("La route de bascule ne renvoie jamais vers un autre site", async ({ request }) => {
    for (const retour of ["https://exemple.test/", "//exemple.test/", "/..//exemple.test", "/\\exemple.test"]) {
      const res = await request.get(`/vue?mode=poche&retour=${encodeURIComponent(retour)}`, { maxRedirects: 0 });
      expect(res.status(), retour).toBe(303);
      expect(res.headers()["location"], retour).toBe("/");
    }
  });
});

test("Écran réservé à l'ordinateur : remplacé par l'encart sur téléphone seulement", async ({ page, isMobile }) => {
  await page.goto("/modeles/cles");
  if (!isMobile) {
    await expect(encart(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Clés fournisseurs", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Version allégée" })).toHaveCount(0);
    return;
  }
  await expect(encart(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cet écran est conçu pour l'ordinateur");
  await expect(page.locator(".topbar")).toContainText("IA & modèles");
  await expect(page.locator(".topbar")).toContainText("Clés fournisseurs");
  // le contenu de l'écran n'est pas envoyé : aucun champ de saisie
  await expect(page.locator(".content input, .content textarea, .content select")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "encart");
  await capture(page, "poche-encart");
});

test.describe("Sur téléphone", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");

  test("Feuille « Plus » : consultation, coupe-circuit, puis ce qui se fait sur ordinateur", async ({ page }) => {
    await page.goto("/");
    await ouvrirPlus(page);
    const s = sheet(page);
    await expect(s.getByRole("heading", { name: "Plus" })).toBeVisible();
    for (const nom of ["Historique des décisions", "Équipe de l'agence", "Rapports mensuels · lecture", "Glossaire", "Coupe-circuit des écritures", "Version complète"]) await expect(s.getByRole("link", { name: nom })).toBeVisible();
    const ordinateur = s.getByRole("group", { name: "Sur ordinateur" });
    await expect(ordinateur.getByRole("link")).toHaveText(["Paramètres", "IA & modèles", "Intégrations", "Création d'un logement", "Analyse", "Méthode"]);
    await expect(s.getByRole("button", { name: "Se déconnecter" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "feuille Plus");
    // la barre basse reste visible sous la feuille
    const feuille = (await s.boundingBox())!, barre = (await page.locator(".bottombar").boundingBox())!;
    expect(feuille.y + feuille.height).toBeLessThanOrEqual(barre.y + 1);
    expect(feuille.y).toBeGreaterThanOrEqual(0);
    await capture(page, "poche-menu-plus");
    // toucher une entrée de la barre ferme la feuille et ouvre l'écran visé
    const cible = (await page.locator(".bottombar a", { hasText: "Logements" }).boundingBox())!;
    await page.touchscreen.tap(cible.x + cible.width / 2, cible.y + cible.height / 2);
    await expect(page).toHaveURL(/\/logements$/);
    await expect(s).toBeHidden();
  });

  test("Bascule : version complète, puis retour à la version allégée sur la même page", async ({ page }) => {
    await page.goto("/historique?essai=1");
    await ouvrirPlus(page);
    await sheet(page).getByRole("link", { name: "Version complète" }).click();
    await expect(page).toHaveURL(/\/historique\?essai=1$/);
    await expect(page.getByRole("link", { name: "Version allégée" })).toBeVisible();
    expect((await cookie(page, "ns_vue"))?.value).toBe("complet");
    await ouvrirPlus(page);
    await expect(sheet(page).getByRole("heading", { name: "Tous les écrans" })).toBeVisible();
    await page.goto("/modeles/cles");
    await expect(encart(page)).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "version complète");
    await capture(page, "poche-version-complete");
    await page.getByRole("link", { name: "Version allégée" }).click();
    await expect(page).toHaveURL(/\/modeles\/cles$/);
    await expect(encart(page)).toBeVisible();
    expect((await cookie(page, "ns_vue"))?.value).toBe("poche");
  });

  test("« Afficher quand même » : retenu pour cet écran jusqu'à la fin de la session", async ({ page }) => {
    await page.goto("/modeles/cles");
    await encart(page).getByRole("link", { name: "Revenir aux opportunités" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/modeles/cles");
    await encart(page).getByRole("link", { name: "Afficher quand même" }).click();
    await expect(page.getByRole("heading", { name: "Clés fournisseurs", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/modeles\/cles$/);
    await expect(encart(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Clés fournisseurs", level: 1 })).toBeVisible();
    // cookie de session : il disparaît à la fermeture du navigateur ; le mode, lui, ne change pas
    expect((await cookie(page, "ns_vue_force"))?.expires).toBe(-1);
    expect(await cookie(page, "ns_vue")).toBeUndefined();
    await page.goto("/parametres");
    await expect(encart(page)).toBeVisible();
    // l'ancre demandée est conservée après le choix
    await page.goto("/modeles/budget#plafond");
    await expect(async () => {
      if (await encart(page).isVisible()) await encart(page).getByRole("link", { name: "Afficher quand même" }).click({ timeout: 2_000 });
      await expect(page).toHaveURL(/\/modeles\/budget#plafond$/, { timeout: 1_000 });
      await expect(encart(page)).toHaveCount(0, { timeout: 1_000 });
    }).toPass();
  });

  test("Intégrations : le coupe-circuit reste affiché au-dessus de l'encart", async ({ page }) => {
    // compte de démo partagé : on regarde sans actionner (le geste est vérifié plus bas, sur un espace propre au test)
    await page.goto("/");
    await ouvrirPlus(page);
    await sheet(page).getByRole("link", { name: "Coupe-circuit des écritures" }).click();
    const bloc = page.getByTestId("coupe-circuit-poche");
    await expect(bloc.getByRole("heading", { name: "Coupe-circuit des écritures" })).toBeVisible();
    await expect(bloc.getByRole("button", { name: /(Activer|Lever) le coupe-circuit/ })).toBeVisible();
    await expect(encart(page)).toBeVisible();
    await expect(page.locator(".stratum")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "coupe-circuit");
    await capture(page, "poche-coupe-circuit");
  });

  test("Téléphone en paysage : la rangée de navigation ouvre la même feuille allégée", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Version complète" })).toBeVisible();
    await expect(async () => {
      if (!(await sheet(page).isVisible())) await page.locator('.navbar button[aria-haspopup="dialog"]').first().click({ timeout: 2_000 });
      await expect(sheet(page)).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect(sheet(page).getByRole("heading", { name: "Plus" })).toBeVisible();
    await sheet(page).getByRole("link", { name: "Version complète" }).scrollIntoViewIfNeeded();
    await expect(sheet(page).getByRole("link", { name: "Version complète" })).toBeInViewport();
    await expectNoHorizontalOverflow(page, "paysage");
    await capture(page, "poche-paysage");
  });

  test("Rapports mensuels : lecture seule, la rédaction renvoie à l'ordinateur", async ({ page }, info) => {
    test.skip(!hasDatabase(), "DATABASE_URL absent : aucun rapport préparé sur cet environnement");
    // un mois par largeur, distinct de ceux des autres fichiers
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - (info.project.name === "mobile-360" ? 15 : 14));
    const mois = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    // brouillons des logements de démonstration du compte de test seulement : rien de réel n'est touché
    const vider = () => sql("delete from monthly_reports where month = $1 and status = 'DRAFT' and property_id in (select p.id from properties p join users u on u.tenant_id = p.tenant_id where u.email = $2 and p.is_demo)", [mois, process.env.E2E_EMAIL]);
    await vider();
    try {
      await page.goto("/vue?mode=complet&retour=/rapports");
      await page.getByLabel("Mois à rapporter").selectOption(mois);
      await page.getByRole("button", { name: "Préparer ou actualiser le rapport" }).click();
      await expect(page.getByText("Rapport préparé")).toBeVisible();

      await page.goto("/vue?mode=poche&retour=/rapports");
      await expect(page.getByTestId("modification-ordinateur")).toBeVisible();
      await expect(page.getByRole("button", { name: "Préparer ou actualiser le rapport" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "rapports en mode poche");
      const label = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
      await page.locator('[data-testid="rapport-ligne"][data-status="DRAFT"]').filter({ hasText: label }).getByRole("link").click();
      await expect(page.getByTestId("rapport-texte")).toBeVisible();
      await expect(page.getByTestId("modification-ordinateur")).toBeVisible();
      await expect(page.getByLabel("Texte du rapport")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Certifier|Enregistrer/ })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "rapport en mode poche");
      await capture(page, "poche-rapport");
    } finally { await vider(); }
  });
});

async function sql(text: string, params: unknown[]) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { return await c.query(text, params); } finally { await c.end(); }
}

test.describe("Sur téléphone, dans un espace propre au test", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");
  test.skip(!hasDatabase(), "DATABASE_URL absent : espace de test non modifiable sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });
  test.describe.configure({ mode: "default" });

  const password = "e2e-poche-passw0rd";
  let tenant = "", email = "";
  test.beforeEach(async ({ page }, info) => {
    const tag = `${info.project.name}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    tenant = `tn_e2e_poche_${tag}`; email = `e2e-poche-${tag}@example.test`;
    const salt = randomBytes(16);
    await sql("insert into tenants (id, name) values ($1, $2)", [tenant, "Test mode poche"]);
    await sql("insert into users (id, tenant_id, email, name, password_hash, role) values ($1, $2, $3, $4, $5, 'OWNER')", [`usr_e2e_poche_${tag}`, tenant, email, "Test poche", `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`]);
    await page.goto("/connexion");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/connexion"), { timeout: 15_000 });
  });
  test.afterEach(async () => {
    await sql("delete from properties where tenant_id = $1", [tenant]);
    await sql("delete from integrations where tenant_id = $1", [tenant]);
    await sql("delete from tenants where id = $1", [tenant]);
  });

  test("Coupe-circuit : activé puis levé depuis le téléphone", async ({ page }) => {
    await page.goto("/integrations");
    const bloc = page.getByTestId("coupe-circuit-poche");
    await expect(bloc).toContainText("Coupe-circuit levé");
    await bloc.getByRole("button", { name: "Activer le coupe-circuit" }).click();
    await expect(bloc).toContainText("Coupe-circuit actif");
    expect((await sql("select kill_switch from integrations where tenant_id = $1 and provider = 'pricelabs'", [tenant])).rows).toEqual([{ kill_switch: true }]);
    await bloc.getByRole("button", { name: "Lever le coupe-circuit" }).click();
    await expect(bloc).toContainText("Coupe-circuit levé");
    expect((await sql("select kill_switch from integrations where tenant_id = $1 and provider = 'pricelabs'", [tenant])).rows).toEqual([{ kill_switch: false }]);
    await expect(encart(page)).toBeVisible();
  });

  test("Écran d'un logement réservé à l'ordinateur : le retour mène à la fiche", async ({ page }) => {
    const res = await page.request.post("/api/v1/properties", { data: { name: "Logement poche", city: "Lille", kind: "T2", bedrooms: 2, capacity: 4 } });
    expect(res.status(), await res.text()).toBe(201);
    const fiche = `/logements/${(await res.json()).id}`;
    await sql("update properties set status = 'SHADOW' where tenant_id = $1", [tenant]);
    await page.goto(`${fiche}/couts`);
    await expect(encart(page)).toBeVisible();
    await expect(page.locator(".topbar")).toContainText("Logement poche");
    await page.getByRole("link", { name: "Retour", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${fiche}$`));
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(encart(page)).toHaveCount(0);
  });

  test("Création d'un logement : un seul choix « Afficher quand même » pour tout le parcours", async ({ page }) => {
    const res = await page.request.post("/api/v1/properties", { data: { name: "Brouillon poche", city: "Lille", kind: "T2", bedrooms: 2, capacity: 4 } });
    expect(res.status(), await res.text()).toBe(201);
    const dossier = `/logements/${(await res.json()).id}/creation`;
    await page.goto(dossier);
    await expect(encart(page)).toBeVisible();
    await page.goto("/logements/nouveau");
    await expect(encart(page)).toBeVisible();
    await expect(page.locator("form input")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Quitter" })).toHaveAttribute("href", "/logements");
    await expect(page.getByRole("link", { name: "Version complète" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "création d'un logement");
    await capture(page, "poche-creation");
    await encart(page).getByRole("link", { name: "Afficher quand même" }).click();
    await expect(encart(page)).toHaveCount(0);
    await expect(page.getByLabel(/Nom du logement/)).toBeVisible();
    await page.goto(dossier);
    await expect(page.locator("main")).toBeVisible();
    await expect(encart(page)).toHaveCount(0);
  });
});

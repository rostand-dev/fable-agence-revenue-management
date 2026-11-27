import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";
import { loginNewTenant, sql } from "./helpers/tenant";
import { versionComplete } from "./helpers/view";

/**
 * Mode poche : Accueil (/portefeuille) et Opportunités (/) compacts. Largeurs de téléphone seulement.
 * Les captures sont jointes aux résultats (sur la Preview : artefact « preview-smoke-captures »).
 */
const cartes = (page: Page) => page.getByTestId("situation");
const capture = async (page: Page, nom: string, fullPage = false) => {
  await page.screenshot({ path: test.info().outputPath(`${nom}.png`), fullPage, animations: "disabled" });
  await test.info().attach(nom, { path: test.info().outputPath(`${nom}.png`), contentType: "image/png" });
};
/** Bas de la zone visible : le haut de la barre de navigation basse. */
const basVisible = async (page: Page) => (await page.locator(".bottombar").boundingBox())!.y;
async function ouvrirFiltres(page: Page) {
  const feuille = page.locator("dialog.pk-filter-sheet");
  // le premier toucher peut précéder l'activation de la page : on réessaie
  await expect(async () => {
    if (!(await feuille.isVisible())) await page.getByRole("button", { name: /^Filtrer/ }).click({ timeout: 2_000 });
    await expect(feuille).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return feuille;
}
/** Ouvre le menu « … » d'une carte. */
const menu = async (carte: Locator) => { await carte.locator("summary").click(); return carte.locator(".pk-menu-list"); };
const poche = (page: Page) => page.context().addCookies([{ name: "ns_vue", value: "poche", url: test.info().project.use.baseURL! }]);

/** Codes et rangs affichés, dans l'ordre, par l'une ou l'autre version. */
const listePoche = async (page: Page) => (await page.locator(".pk-sit-ref").allInnerTexts()).map((t) => t.trim());
const listeComplete = (page: Page) => page.locator("article.sit").evaluateAll((els) => els.map((e) => {
  const rank = /#(\d+)/.exec(e.querySelector(".sit-rank-no")?.textContent ?? "")?.[1];
  return `${rank ? `#${rank} · ` : ""}${e.querySelector(".tag-mono")?.textContent ?? ""}`;
}));

test.describe("Sur téléphone, compte de démonstration", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");

  test("Accueil : phrase d'état, trois compteurs, situation prioritaire, tendances par logement", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/portefeuille");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/situation|Rien à arbitrer/);
    await expect(page.getByTestId("pk-etat")).toContainText(/alertes? d'exécution/);
    await expect(page.getByTestId("pf-decider").getByRole("link")).toHaveText([/À décider\s*\d+/i, /Sous veto\s*\d+/i, /Urgents\s*\d+/i]);
    const priorite = page.getByTestId("pk-priorite");
    await expect(priorite).toContainText("Priorité #1");
    await expect(priorite).toHaveAttribute("href", /^\/dossier\//);
    const box = (await priorite.boundingBox())!;
    expect(box.y + box.height, "situation prioritaire visible sans défiler").toBeLessThanOrEqual(await basVisible(page));
    const logements = page.getByTestId("pk-logement");
    expect(await logements.count()).toBeGreaterThan(0);
    for (const l of await logements.all()) {
      await expect(l).toHaveAttribute("href", /^\/logements\//);
      await expect(l.locator(".pk-trend-name")).toHaveText(["Revenu", "Occupation", "Prix moyen"]);
      for (const v of await l.locator(".pk-trend-value").allInnerTexts()) expect(v).toMatch(/en hausse|stable|en baisse|inconnue?/);
      // une tendance inconnue dit pourquoi
      if (await l.locator(".pk-trend.is-unknown").count()) await expect(l.locator(".pk-trend-why")).toContainText("Inconnu :");
    }
    await expect(page.locator(".pk-note")).toContainText("nuits réservées à ce jour");
    for (const t of ["pf-actions", "pf-kpi", "pf-integrations"]) await expect(page.getByTestId(t)).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "accueil en mode poche");
    await capture(page, "poche-accueil");
    await capture(page, "poche-accueil-entier", true);
    expect(errors, "erreurs JavaScript").toEqual([]);
  });

  test("Accueil : chaque compteur mène à une liste de même taille", async ({ page }) => {
    for (const [nom, url] of [["À décider", /\/$/], ["Sous veto", /\/\?u=veto$/], ["Urgents", /\/\?u=urgent$/]] as const) {
      await page.goto("/portefeuille");
      const compteur = page.getByTestId("pf-decider").getByRole("link", { name: new RegExp(nom, "i") });
      const n = Number(/(\d+)/.exec(await compteur.innerText())?.[1]);
      await compteur.click();
      await expect(page).toHaveURL(url);
      await expect(cartes(page), `liste « ${nom} »`).toHaveCount(n);
    }
  });

  test("Opportunités : la première situation est visible sans défiler, chaque carte reste courte", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Opportunités");
    const premiere = cartes(page).first();
    await expect(premiere).toBeVisible();
    const box = (await premiere.boundingBox())!;
    expect(box.y + box.height, "première carte entière à l'écran").toBeLessThanOrEqual(await basVisible(page));
    for (const [i, c] of (await cartes(page).all()).entries()) expect((await c.boundingBox())!.height, `hauteur de la carte ${i + 1}`).toBeLessThanOrEqual(300);
    // ni synthèse, ni bloc équipe, ni carte complète ; les filtres attendent le bouton
    for (const sel of [".synth", ".crew", "article.sit", ".page-head"]) await expect(page.locator(sel)).toHaveCount(0);
    await expect(page.getByTestId("inbox-filtres")).toBeHidden();
    await expect(page.getByRole("group", { name: "Raccourcis" }).getByRole("link")).toHaveText([/^À traiter · \d+$/, /^Urgents · \d+$/]);
    await expectNoHorizontalOverflow(page, "opportunités en mode poche");
    await capture(page, "poche-opportunites");
    await capture(page, "poche-opportunites-entier", true);
    expect(errors, "erreurs JavaScript").toEqual([]);
  });

  test("Opportunités : « Approuver » jamais sur un veto ni sur une validation renforcée", async ({ page }) => {
    await page.goto("/?u=veto");
    const vetos = await cartes(page).all();
    expect(vetos.length, "la démonstration doit comporter un veto").toBeGreaterThan(0);
    for (const c of vetos) {
      await expect(c).toContainText("Veto économique");
      await expect(c.getByRole("button", { name: /Approuver|Retenir l'inaction/ })).toHaveCount(0);
      await expect(c.getByRole("link", { name: "Arbitrer" })).toHaveAttribute("href", /^\/dossier\/.+#decision$/);
    }
    // sur un veto, le menu ne propose pas de différer
    const m = await menu(vetos[0]);
    await expect(m.getByRole("button", { name: "Relancer la revue" })).toBeVisible();
    await expect(m.getByRole("button", { name: "Différer de 3 jours" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "menu ouvert sur un veto");
    await capture(page, "poche-menu-veto");

    // menu : Échap puis un appui ailleurs le referment
    await page.keyboard.press("Escape");
    await expect(m).toBeHidden();
    await menu(vetos[0]);
    await page.getByRole("heading", { level: 1 }).click();
    await expect(m).toBeHidden();

    await page.goto("/");
    const gardees = cartes(page).filter({ hasText: /Validation renforcée|Veto économique/ });
    expect(await gardees.count(), "la démonstration doit comporter des options à arbitrer au dossier").toBeGreaterThan(0);
    for (const c of await gardees.all()) await expect(c.getByRole("button", { name: /Approuver|Retenir l'inaction/ })).toHaveCount(0);
  });

  test("Opportunités : mêmes filtres, mêmes adresses et mêmes listes que la version complète", async ({ page }) => {
    await page.goto("/");
    const total = await cartes(page).count();
    await expect(page.getByRole("link", { name: `À traiter · ${total}` })).toHaveAttribute("aria-current", "true");
    const urgents = page.getByRole("link", { name: /^Urgents · \d+$/ });
    const nUrgents = Number(/(\d+)$/.exec(await urgents.innerText())![1]);
    await urgents.click();
    await expect(page).toHaveURL(/\/\?u=urgent$/);
    await expect(cartes(page)).toHaveCount(nUrgents);

    await page.goto("/");
    let feuille = await ouvrirFiltres(page);
    for (const l of ["Logement", "Playbook", "Urgence", "Tri"]) await expect(feuille.getByLabel(l)).toBeVisible();
    await expect(feuille.getByRole("group", { name: "Filtrer par statut" }).getByRole("link")).toHaveText(["À traiter", "Garde-fous & vetos", "Traitées", "Toutes"]);
    await expectNoHorizontalOverflow(page, "feuille de filtres");
    await capture(page, "poche-filtres");
    // une puce de statut referme la feuille
    await feuille.getByRole("link", { name: "Toutes" }).click();
    await expect(page).toHaveURL(/\/\?f=toutes$/);
    await expect(feuille).toBeHidden();
    // le formulaire garde le statut et produit la même adresse que la version complète
    feuille = await ouvrirFiltres(page);
    const logement = (await feuille.getByLabel("Logement").locator("option").nth(1).getAttribute("value"))!;
    await feuille.getByLabel("Logement").selectOption(logement);
    await feuille.getByRole("button", { name: "Appliquer" }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?f=toutes&p=${logement}&pb=&u=&s=priorite$`));
    await expect(page.getByTestId("inbox-compteur")).toContainText("2 filtres actifs");
    const duLogement = await cartes(page).count();
    // les compteurs des puces suivent le filtre de logement
    await page.getByRole("link", { name: /^À traiter · \d+$/ }).click();
    const nLogement = Number(/(\d+)$/.exec(await page.getByRole("link", { name: /^À traiter · \d+$/ }).innerText())![1]);
    await expect(cartes(page)).toHaveCount(nLogement);
    expect(nLogement).toBeLessThanOrEqual(duLogement);
    await page.getByTestId("reinitialiser").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cartes(page)).toHaveCount(total);
    // la feuille rouverte reflète l'adresse réinitialisée
    await expect((await ouvrirFiltres(page)).getByLabel("Logement")).toHaveValue("");

    for (const url of ["/", "/?u=urgent&s=sejour", "/?f=toutes&s=impact", `/?p=${logement}`]) {
      // compte partagé : d'autres tests y ajoutent et retirent des dossiers entre les deux lectures, d'où la reprise
      await expect(async () => {
        await poche(page); await page.goto(url);
        const compact = await listePoche(page);
        await versionComplete(page.context()); await page.goto(url);
        await expect(page.locator("article.sit")).toHaveCount(compact.length, { timeout: 2_000 });
        expect(compact, url).toEqual(await listeComplete(page));
      }).toPass({ timeout: 30_000 });
    }
  });

  test("Cibles tactiles et retours de la version complète", async ({ page }) => {
    await page.goto("/");
    await expect(async () => {
      if (!(await page.locator("dialog.nav-sheet").isVisible())) await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: /Plus/ }).click({ timeout: 2_000 });
      await expect(page.locator("dialog.nav-sheet")).toBeVisible({ timeout: 1_000 });
    }).toPass();
    for (const l of await page.getByRole("group", { name: "Sur ordinateur" }).getByRole("link").all()) expect((await l.boundingBox())!.height, await l.innerText()).toBeGreaterThanOrEqual(43.5);
    // création d'un logement en version complète sur téléphone : le retour est proposé
    await versionComplete(page.context());
    await page.goto("/logements/nouveau");
    const retour = page.getByRole("link", { name: "Version allégée" });
    await expect(retour).toBeVisible();
    await expectNoHorizontalOverflow(page, "création en version complète");
    await retour.click();
    await expect(page).toHaveURL(/\/logements\/nouveau$/);
    await expect(page.getByTestId("ecran-ordinateur")).toBeVisible();
  });
});

// Les décisions modifient les données : un espace propre au test, avec sa propre démonstration.
test.describe("Sur téléphone, décider depuis la carte", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");
  test.skip(!hasDatabase(), "DATABASE_URL absent : espace de test non créable sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });

  let tenant = "", drop = async () => {};
  test.beforeEach(async ({ page }, info) => {
    ({ tenant, drop } = await loginNewTenant(page, info, "Test poche décisions"));
    await versionComplete(page.context());
    await page.goto("/parametres/demo");
    await page.getByRole("button", { name: "Réinstaller la démonstration à la date du jour" }).click();
    await expect(page.getByText("Démonstration réinstallée à la date du jour.")).toBeVisible({ timeout: 30_000 });
    await poche(page);
  });
  test.afterEach(() => drop());

  const etat = async (code: string) => (await sql("select status, decision from opportunities where tenant_id = $1 and code = $2", [tenant, code])).rows[0];
  const codeDe = async (carte: Locator) => (await carte.locator(".pk-sit-ref").innerText()).split("·").pop()!.trim();

  test("« Approuver » et « Différer » agissent comme en version complète", async ({ page }) => {
    await page.goto("/");
    const avant = await cartes(page).count();
    const approuvable = cartes(page).filter({ has: page.getByRole("button", { name: /^(Approuver|Retenir l'inaction)$/ }) }).first();
    await expect(approuvable, "la démonstration doit comporter une option approuvable depuis la carte").toBeVisible();
    const approuve = await codeDe(approuvable);
    await approuvable.getByRole("button", { name: /^(Approuver|Retenir l'inaction)$/ }).click();
    await expect(cartes(page)).toHaveCount(avant - 1);
    expect((await etat(approuve)).status).toBe("DECIDED");

    const differable = cartes(page).filter({ hasNotText: "Veto économique" }).first();
    const differe = await codeDe(differable);
    await (await menu(differable)).getByRole("button", { name: "Différer de 3 jours" }).click();
    await expect(cartes(page)).toHaveCount(avant - 2);
    expect((await etat(differe)).status).toBe("DEFERRED");
    await page.goto("/?f=toutes");
    const reportee = cartes(page).filter({ hasText: differe });
    await expect(reportee).toContainText("Différé");
    await expect(reportee.getByRole("link", { name: "Voir le dossier" })).toBeVisible();
    await expect(reportee.locator("summary")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "situations traitées");

    // l'accueil annonce ce qui reste à exécuter, et l'inconnu garde son motif
    await page.goto("/portefeuille");
    await expect(page.getByTestId("pk-logement")).toHaveCount(2);
    await capture(page, "poche-accueil-apres-decisions", true);
  });

  test("« Relancer la revue » reste proposé quand plus rien n'est à arbitrer", async ({ page }) => {
    await sql("update opportunities set status = 'DEFERRED' where tenant_id = $1 and status = 'OPEN'", [tenant]);
    await page.goto("/");
    await expect(cartes(page)).toHaveCount(0);
    const relancer = page.getByRole("button", { name: "Relancer la revue" });
    expect((await relancer.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    await expectNoHorizontalOverflow(page, "rien à arbitrer");
    await capture(page, "poche-rien-a-arbitrer");
    await relancer.click();
    await expect(page.getByText("Revue terminée.")).toBeVisible({ timeout: 30_000 });
  });

  test("« Relancer la revue » depuis le menu d'une carte", async ({ page }) => {
    await page.goto("/");
    const m = await menu(cartes(page).first());
    await m.getByRole("button", { name: "Relancer la revue" }).click();
    await expect(page.getByText("Revue terminée.")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page, "revue relancée");
  });
});

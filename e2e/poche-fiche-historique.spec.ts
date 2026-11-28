import { expect, test, type Page } from "@playwright/test";
import { contenuCoupe, expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";
import { loginNewTenant, sql } from "./helpers/tenant";
import { versionComplete } from "./helpers/view";

/**
 * Fiche d'un logement et historique en mode poche. Largeurs de téléphone, sauf le dernier test (ordinateur inchangé).
 * Les captures sont jointes aux résultats (sur la Preview : artefact « preview-smoke-captures »).
 */
const capture = async (page: Page, nom: string, fullPage = false) => {
  await page.screenshot({ path: test.info().outputPath(`${nom}.png`), fullPage, animations: "disabled" });
  await test.info().attach(nom, { path: test.info().outputPath(`${nom}.png`), contentType: "image/png" });
};
const fiche = (page: Page) => page.getByTestId("fiche-poche");
const encart = (page: Page) => page.getByTestId("ecran-ordinateur");
const nuits = (page: Page) => page.getByTestId("pk-nuits").locator("li");
const ligne = (page: Page, key: string) => fiche(page).locator(`[data-line="${key}"]`);

type Logement = { id: string; name: string; isDemo: boolean };
async function logementsDemo(page: Page): Promise<Logement[]> {
  const list: Logement[] = (await (await page.request.get("/api/v1/properties")).json()).properties;
  const demos = list.filter((p) => p.isDemo);
  expect(demos.length, "logements de démonstration").toBeGreaterThan(0);
  return demos;
}

/** Bas de la zone visible : le haut de la barre de navigation. */
const basVisible = async (page: Page) => (await page.locator(".bottombar").boundingBox())!.y;

/** Cibles tactiles d'au moins 44 px sur les liens et boutons visibles de `racine`. */
async function ciblesTactiles(page: Page, selector: string) {
  const petites = await page.locator(`${selector} >> visible=true`).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => `${Math.round(e.getBoundingClientRect().height)} px : ${(e.textContent ?? "").trim().slice(0, 40)}`));
  expect(petites, "cibles tactiles trop basses").toEqual([]);
}

/** Chaque onglet réservé à l'ordinateur, avec le titre de sa rubrique. */
const RESERVES: [string, string[]][] = [
  ["calendrier", ["calendrier"]],
  ["strategie", ["hub-strategie", "strategie", "canaux"]],
  ["economie", ["hub-economie", "economie"]],
  ["donnees", ["hub-donnees", "donnees", "annonces", "pricelabs", "superhote"]],
];

test.describe("Sur téléphone, fiche d'un logement de démonstration", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");

  test("En-tête, mois en cours, quatorze jours et lignes d'état", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    for (const [i, p] of (await logementsDemo(page)).entries()) {
      await page.goto(`/logements/${p.id}`);
      await expect(fiche(page)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(p.name);
      await expect(page.getByRole("link", { name: "Retour aux logements" })).toHaveAttribute("href", "/logements");
      const arbitrer = page.getByTestId("pk-arbitrer");
      await expect(arbitrer).toContainText(/\d+ à arbitrer|rien à arbitrer/);
      if (/\d+ à arbitrer/.test(await arbitrer.innerText())) await expect(arbitrer).toHaveAttribute("href", `/?p=${p.id}`);

      const mois = page.getByTestId("pk-mois");
      await expect(mois.locator("[data-trend]")).toHaveCount(3);
      await expect(mois).toContainText(/Revenu net[\s\S]*Occupation[\s\S]*Prix moyen net/);
      await expect(mois.locator(".pk-trend-value")).toHaveText([/en hausse|stable|en baisse|inconnue/, /en hausse|stable|en baisse|inconnue/, /en hausse|stable|en baisse|inconnue/]);
      await expect(fiche(page).getByRole("heading", { name: /réservé à ce jour · vs / })).toBeVisible();

      // quatorze jours consécutifs à partir d'aujourd'hui (heure de Paris)
      const jours = await nuits(page).evaluateAll((els) => els.map((e) => ({ date: e.getAttribute("data-date")!, state: e.getAttribute("data-state")!, price: e.querySelector(".pk-night-price")!.textContent ?? "", x: e.getBoundingClientRect().x, y: Math.round(e.getBoundingClientRect().y) })));
      expect(jours).toHaveLength(14);
      expect(jours[0].date).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()));
      for (let j = 1; j < jours.length; j++) expect(Date.parse(jours[j].date) - Date.parse(jours[j - 1].date), jours[j].date).toBe(86_400_000);
      expect(new Set(jours.map((j) => j.y)).size, "grille sur deux rangées").toBe(2);
      expect(new Set(jours.map((j) => Math.round(j.x))).size, "grille de sept colonnes").toBe(7);
      for (const j of jours) {
        if (j.state === "FREE") expect(j.price, `prix de la nuit libre ${j.date}`).toMatch(/€|\?/);
        else expect(j.price, `pas de prix sur la nuit ${j.date}`).toBe("");
      }

      await expect(fiche(page).locator("[data-line]")).toHaveCount(5);
      await expect(ligne(page, "strategie")).toContainText(/v\d+ active/);
      await expect(ligne(page, "donnees")).toContainText("calendrier lu jusqu'au");
      await expect(ligne(page, "economie")).toContainText("sur ordinateur");
      // ni calendrier à 90 jours, ni onglets, ni saisie
      for (const sel of [".cal-grid", ".tabs", ".property-sections", "form"]) await expect(page.locator(`.content ${sel} >> visible=true`)).toHaveCount(0);
      await ciblesTactiles(page, '[data-testid="fiche-poche"] a, [data-testid="fiche-poche"] summary, .pk-prop-top a');
      await expectNoHorizontalOverflow(page, `fiche de poche ${p.name}`);
      expect(await contenuCoupe(page, '[data-testid="fiche-poche"]'), "contenu coupé").toEqual([]);
      expect(await contenuCoupe(page, ".pk-prop-top"), "en-tête coupé").toEqual([]);
      await capture(page, `poche-fiche-${i + 1}`);
      await capture(page, `poche-fiche-${i + 1}-entiere`, true);
    }
    expect(errors, "erreurs JavaScript").toEqual([]);
  });

  test("Les lignes d'état mènent à leur rubrique ; performance et historique restent consultables", async ({ page }) => {
    const [p] = await logementsDemo(page);
    for (const [key, attendu] of [["strategie", "encart"], ["donnees", "encart"], ["economie", "encart"], ["performance", "page"], ["historique", "page"]] as const) {
      await page.goto(`/logements/${p.id}`);
      await ligne(page, key).click();
      await expect(page).toHaveURL(new RegExp(`/logements/${p.id}\\?tab=`));
      await expect(page.locator(".content")).toBeVisible();
      await expect(encart(page), key).toHaveCount(attendu === "encart" ? 1 : 0);
      await expect(fiche(page)).toHaveCount(0);
      await expectNoHorizontalOverflow(page, `rubrique ${key}`);
    }
  });

  test("Onglets réservés : encart « sur ordinateur », et « Afficher quand même » vaut pour la rubrique", async ({ page }) => {
    const [p] = await logementsDemo(page);
    for (const [rubrique, onglets] of RESERVES) for (const tab of onglets) {
      await page.goto(`/logements/${p.id}?tab=${tab}`);
      await expect(encart(page), `onglet ${tab} (${rubrique})`).toBeVisible();
      await expect(page.locator(".content table, .content form.sb-form, .cal-grid")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, `encart ${tab}`);
    }
    await page.goto(`/logements/${p.id}?tab=calendrier`);
    await capture(page, "poche-fiche-encart-calendrier");
    // retour : la fiche
    await page.locator(".pk-topbar a.pk-back").click();
    await expect(page).toHaveURL(new RegExp(`/logements/${p.id}$`));
    await expect(fiche(page)).toBeVisible();

    await page.goto(`/logements/${p.id}?tab=strategie`);
    await encart(page).getByRole("link", { name: "Afficher quand même" }).click();
    await expect(page).toHaveURL(new RegExp(`/logements/${p.id}\\?tab=strategie$`));
    await expect(encart(page)).toHaveCount(0);
    // le choix couvre les autres écrans de la rubrique, pas les autres rubriques
    await page.goto(`/logements/${p.id}?tab=canaux`);
    await expect(encart(page)).toHaveCount(0);
    // … et les sous-pages de la même rubrique
    await page.goto(`/logements/${p.id}/compilateur`);
    await expect(page.locator(".content")).toBeVisible();
    await expect(encart(page)).toHaveCount(0);
    for (const tab of ["economie", "calendrier", "donnees"]) {
      await page.goto(`/logements/${p.id}?tab=${tab}`);
      await expect(encart(page), `autre rubrique ${tab}`).toBeVisible();
    }
  });

  test("Depuis performance ou historique, le menu des sections mène à l'encart puis ramène à la fiche", async ({ page }) => {
    const [p] = await logementsDemo(page);
    for (const tab of ["performance", "historique"]) {
      await page.goto(`/logements/${p.id}?tab=${tab}`);
      const feuille = page.locator(".section-switcher-btn");
      const choisir = async (nom: RegExp) => {
        await expect(async () => {
          const menu = page.locator("dialog[open]");
          if (!(await menu.isVisible())) await feuille.click({ timeout: 2_000 });
          const lien = menu.getByRole("link", { name: nom }).first();
          // une section à plusieurs écrans est repliée quand elle n'est pas la section courante
          if (!(await lien.isVisible())) await menu.locator("summary", { hasText: nom }).click({ timeout: 2_000 });
          await lien.click({ timeout: 2_000 });
        }).toPass();
      };
      await choisir(/Calendrier 90 jours/);
      await expect(page).toHaveURL(/tab=calendrier$/);
      await expect(encart(page)).toBeVisible();
      await page.goto(`/logements/${p.id}?tab=${tab}`);
      await choisir(/Vue d'ensemble/);
      await expect(page).toHaveURL(new RegExp(`/logements/${p.id}$`));
      await expect(fiche(page)).toBeVisible();
    }
    await page.goto(`/logements/${p.id}?lance=1`);
    await expect(fiche(page)).toContainText("Observation lancée");
    await expectNoHorizontalOverflow(page, "fiche après le lancement");
  });

  test("Historique : dix décisions au plus, le journal derrière « Version complète »", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/historique");
    const ecran = page.getByTestId("historique-poche");
    await expect(ecran.getByRole("heading", { level: 1 })).toHaveText("Dernières décisions");
    const cartes = ecran.getByTestId("pk-decision");
    await expect(cartes.first()).toBeVisible();
    expect(await cartes.count()).toBeLessThanOrEqual(10);
    await expect(cartes.first()).toHaveAttribute("href", /^\/dossier\/S-/);
    await expect(page.locator(".content table, .content form")).toHaveCount(0);
    await expect(page.locator(".content").getByTestId("journal-filtres")).toHaveCount(0);
    await ciblesTactiles(page, '[data-testid="historique-poche"] a');
    await expectNoHorizontalOverflow(page, "historique de poche");
    expect(await contenuCoupe(page, '[data-testid="historique-poche"]'), "contenu coupé").toEqual([]);
    await capture(page, "poche-historique");
    await capture(page, "poche-historique-entier", true);

    await ecran.getByTestId("pk-version-complete").click();
    await expect(page).toHaveURL(/\/historique#journal$/);
    await expect(page.getByRole("heading", { name: "Ce qui a été décidé, et ce que cela a produit" })).toBeAttached();
    await expect(page.locator("#journal")).toBeInViewport();
    await expect(page.getByTestId("historique-poche")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "journal en version complète");
    // le retour à la version allégée est proposé
    await page.getByRole("link", { name: "Version allégée" }).click();
    await expect(page.getByTestId("historique-poche")).toBeVisible();
    expect(errors, "erreurs JavaScript").toEqual([]);
  });
});

test.describe("Sur téléphone, historique d'un rôle sans journal", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");
  test.skip(!hasDatabase(), "DATABASE_URL absent : comptes de rôles non créables sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Analyste : les décisions, et la réserve sur le journal", async ({ page }, info) => {
    const u = await createRoleUser("ANALYST", `${info.project.name.replace(/\W/g, "")}-${info.parallelIndex}-${Date.now().toString(36)}`);
    try {
      await page.goto("/connexion");
      await page.getByLabel("Adresse e-mail").fill(u.email);
      await page.getByLabel("Mot de passe").fill(u.password);
      await page.getByRole("button", { name: "Se connecter" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
      await page.goto("/historique");
      await expect(page.getByTestId("pk-decision").first()).toBeVisible();
      await expect(page.getByTestId("journal-reserve")).toContainText("Journal réservé");
      await expect(page.getByTestId("pk-version-complete")).toContainText("Tableau des actions");
      await expectNoHorizontalOverflow(page, "historique sans droit sur le journal");
      await capture(page, "poche-historique-analyste", true);
    } finally { await deleteUser(u.id); }
  });
});

// Les cas qui modifient les données : un espace propre au test, avec sa propre démonstration.
test.describe("Sur téléphone, fiche et historique selon les données", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");
  test.skip(!hasDatabase(), "DATABASE_URL absent : espace de test non créable sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });

  let tenant = "", drop = async () => {};
  test.beforeEach(async ({ page }, info) => {
    ({ tenant, drop } = await loginNewTenant(page, info, "Test poche fiche"));
    await versionComplete(page.context());
    await page.goto("/parametres/demo");
    await page.getByRole("button", { name: "Réinstaller la démonstration à la date du jour" }).click();
    await expect(page.getByText("Démonstration réinstallée à la date du jour.")).toBeVisible({ timeout: 30_000 });
    await page.context().addCookies([{ name: "ns_vue", value: "poche", url: test.info().project.use.baseURL! }]);
  });
  test.afterEach(() => drop());

  /** Le logement de démonstration qui porte un veto sur des nuits libres. */
  const sousVeto = async (): Promise<string> => (await sql(
    `select o.property_id as id from opportunities o where o.tenant_id = $1 and o.status = 'OPEN' and o.veto
       and exists (select 1 from calendar_days c where c.property_id = o.property_id and c.state = 'FREE' and c.date >= o.stay_from and c.date < o.stay_to
         and c.date >= (now() at time zone 'Europe/Paris')::date and c.date < (now() at time zone 'Europe/Paris')::date + 14) limit 1`, [tenant])).rows[0]?.id;

  test("Nuits sous veto signalées, et leur lien ouvre le dossier", async ({ page }) => {
    const id = await sousVeto();
    expect(id, "la démonstration doit comporter un veto sur des nuits libres des quatorze prochains jours").toBeTruthy();
    await page.goto(`/logements/${id}`);
    await expect(page.getByTestId("pk-arbitrer")).toContainText("dont");
    const veto = page.locator('[data-testid="pk-nuits"] li.is-veto');
    expect(await veto.count()).toBeGreaterThan(0);
    for (const li of await veto.all()) {
      await expect(li).toHaveAttribute("data-state", "FREE");
      await expect(li.locator(".pk-night-mark")).toHaveText("!");
      await expect(li).toContainText("situation sous veto");
    }
    await expect(page.getByTestId("pk-nuits-note")).toContainText("sous veto");
    const premier = page.getByTestId("pk-nuits-situations").getByRole("link").first();
    await expect(premier).toContainText(/Libre.*: situation sous veto/);
    await premier.click();
    await expect(page).toHaveURL(/\/dossier\/S-/);
    await expect(page.getByTestId("motif-veto")).toBeVisible();
  });

  test("À 390 px, chaque fiche tient sur un écran", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile-390", "mesure faite à 390 × 844");
    // une situation au plus sous la grille : la hauteur de la liste des liens dépend du nombre de dossiers
    for (const p of await logementsDemo(page)) {
      await page.goto(`/logements/${p.id}`);
      const liens = await page.getByTestId("pk-nuits-situations").getByRole("link").count();
      expect(liens, `${p.name} : liens sous la grille`).toBeLessThanOrEqual(1);
      const box = (await page.getByTestId("pk-rubriques").boundingBox())!;
      expect(box.y + box.height, `${p.name} : dernière ligne d'état au-dessus de la barre de navigation`).toBeLessThanOrEqual(await basVisible(page));
      await expect(page.getByTestId("pk-nuits")).toBeInViewport({ ratio: 1 });
    }
  });

  test("Données manquantes ou en échec : dites inconnues, jamais remplacées", async ({ page }) => {
    const id = await sousVeto();
    // deux nuits non lues, un logement réel dont la dernière lecture SuperHote a échoué
    await sql("delete from calendar_days where property_id = $1 and date in ((now() at time zone 'Europe/Paris')::date + 3, (now() at time zone 'Europe/Paris')::date + 4)", [id]);
    await sql(`update properties set is_demo = false, superhote = '{"rentalId":"e2e","lastSync":{"ok":false,"at":"2026-01-01T00:00:00Z","message":"panne simulée"}}'::jsonb where id = $1`, [id]);
    await page.goto(`/logements/${id}`);
    const inconnues = page.locator('[data-testid="pk-nuits"] li[data-state="UNKNOWN"]');
    await expect(inconnues).toHaveCount(2);
    await expect(inconnues.first()).toContainText("nuit non lue");
    await expect(nuits(page)).toHaveCount(14);
    await expect(page.getByTestId("pk-nuits-note")).toContainText("non lu");
    await expect(ligne(page, "donnees")).toContainText("SuperHote : lecture en échec");
    await expect(ligne(page, "donnees")).toHaveClass(/is-attention/);
    await expectNoHorizontalOverflow(page, "fiche avec lecture en échec");
    await capture(page, "poche-fiche-donnees-manquantes", true);

    // aucun calendrier, et plus aucune réservation : valeurs et tendances inconnues avec leur motif
    await sql("delete from calendar_days where property_id = $1", [id]);
    await sql("delete from reservations where property_id = $1", [id]);
    await sql("update properties set superhote = null where id = $1", [id]);
    await page.goto(`/logements/${id}`);
    await expect(page.getByTestId("pk-sans-calendrier")).toBeVisible();
    await expect(page.getByTestId("pk-nuits")).toHaveCount(0);
    await expect(ligne(page, "donnees")).toContainText("aucun calendrier lu");
    await expect(page.getByTestId("pk-mois").locator(".pk-month-value")).toHaveText([/inconnu/, /inconnu/, /inconnu/]);
    await expect(page.getByTestId("pk-mois-absent")).toContainText("Valeur inconnue :");
    await expect(page.getByTestId("pk-mois")).not.toContainText("0 €");
    await expectNoHorizontalOverflow(page, "fiche sans calendrier");
    await capture(page, "poche-fiche-sans-calendrier", true);
  });

  test("« Afficher quand même » choisi sur une sous-page vaut pour toute sa rubrique", async ({ page }) => {
    const id = await sousVeto();
    await sql("update properties set is_demo = false where id = $1", [id]);
    await page.goto(`/logements/${id}/saisons`);
    await expect(encart(page)).toContainText("retenu pour cette rubrique du logement");
    await encart(page).getByRole("link", { name: "Afficher quand même" }).click();
    await expect(page).toHaveURL(new RegExp(`/logements/${id}/saisons$`));
    await expect(page.getByTestId("season-row").first()).toBeVisible();
    for (const adresse of ["?tab=hub-economie", "?tab=economie", "/couts"]) {
      await page.goto(`/logements/${id}${adresse}`);
      await expect(page.locator(".content")).toBeVisible();
      await expect(encart(page), adresse).toHaveCount(0);
    }
    await page.goto(`/logements/${id}/qualite`);
    await expect(encart(page), "autre rubrique : données").toBeVisible();
  });

  test("Un prix d'au moins 1 000 € ne se coupe pas entre ses milliers", async ({ page }) => {
    const id = await sousVeto();
    await sql("update calendar_days set sent_price_cents = 125000, price_cents = 125000, recommended_price_cents = 125000 where property_id = $1 and state = 'FREE'", [id]);
    await sql(`update properties set channel_markups = '[{"key":"AIRBNB","label":"Airbnb","pct":0}]'::jsonb where id = $1`, [id]);
    await page.goto(`/logements/${id}`);
    const prix = page.locator('[data-testid="pk-nuits"] li[data-state="FREE"] .pk-night-price').first();
    await expect(prix).toContainText(/~1\s250\s€/);
    // « ~1 250 » tient sur une seule ligne ; le symbole « € » a le droit de passer à la suivante
    const lignes = await prix.evaluate((e) => {
      const texte = e.firstChild!.textContent!, r = document.createRange();
      r.setStart(e.firstChild!, 0); r.setEnd(e.firstChild!, texte.indexOf("0") + 1);
      return new Set(Array.from(r.getClientRects(), (b) => Math.round(b.y))).size;
    });
    expect(lignes).toBe(1);
    await expect(page.getByTestId("pk-nuits-note")).toContainText("prix estimé sur Airbnb");
    expect(await contenuCoupe(page, '[data-testid="fiche-poche"]'), "contenu coupé").toEqual([]);
    await expectNoHorizontalOverflow(page, "prix à quatre chiffres");
    await capture(page, "poche-fiche-prix-eleves", true);
  });

  test("Brouillon de logement : reprise de la création proposée", async ({ page }) => {
    const id = await sousVeto();
    await sql("update properties set status = 'ONBOARDING', is_demo = false where id = $1", [id]);
    await page.goto(`/logements/${id}`);
    await expect(fiche(page)).toContainText("Création du logement en cours");
    await expect(fiche(page).getByRole("link", { name: "Reprendre la création" })).toHaveAttribute("href", `/logements/${id}/creation`);
    await expect(ligne(page, "strategie")).toContainText("après la création");
    await ciblesTactiles(page, '[data-testid="fiche-poche"] a');
    await expectNoHorizontalOverflow(page, "fiche d'un brouillon");
    await capture(page, "poche-fiche-brouillon", true);
  });

  test("Historique : les dix décisions les plus récentes seulement", async ({ page }) => {
    // douze décisions de plus, copiées d'un dossier existant, la première étant la plus récente
    await sql(`insert into opportunities select (jsonb_populate_record(null::opportunities, to_jsonb(o) || jsonb_build_object(
        'id', o.id || '_c' || n, 'code', 'S-9999-' || lpad(n::text, 2, '0'), 'dedupe_key', o.dedupe_key || '_c' || n,
        'status', 'DECIDED', 'decision', 'REJECTED', 'decided_at', now() - n * interval '1 minute'))).*
      from (select * from opportunities where tenant_id = $1 order by id limit 1) o, generate_series(1, 12) n`, [tenant]);
    await page.goto("/historique");
    const cartes = page.getByTestId("pk-decision");
    await expect(cartes).toHaveCount(10);
    await expect(cartes.first()).toContainText("S-9999-01");
    await expect(cartes.last()).toContainText("S-9999-10");
    await expect(page.getByTestId("historique-poche")).toContainText("les 10 plus récentes");
    await expectNoHorizontalOverflow(page, "historique plein");
    // aucune décision : l'écran le dit
    await sql("update opportunities set status = 'OPEN', decided_at = null, decision = null where tenant_id = $1", [tenant]);
    await page.reload();
    await expect(cartes).toHaveCount(0);
    await expect(page.getByTestId("historique-poche")).toContainText("Aucune décision pour l'instant");
    await capture(page, "poche-historique-vide", true);
  });
});

test("Sur ordinateur, la fiche et l'historique sont inchangés", async ({ page, isMobile }) => {
  test.skip(isMobile, "largeur d'ordinateur");
  const [p] = await logementsDemo(page);
  await page.goto(`/logements/${p.id}`);
  await expect(fiche(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: p.name })).toBeVisible();
  await page.goto(`/logements/${p.id}?tab=calendrier`);
  await expect(encart(page)).toHaveCount(0);
  await page.goto("/historique");
  await expect(page.getByTestId("historique-poche")).toHaveCount(0);
  await expect(page.locator("#journal")).toBeVisible();
});

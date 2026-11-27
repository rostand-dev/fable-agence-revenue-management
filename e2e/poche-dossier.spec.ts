import { expect, test, type Locator, type Page } from "@playwright/test";
import { deplierDossier } from "./helpers/dossier";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";
import { loginNewTenant, sql } from "./helpers/tenant";
import { versionComplete } from "./helpers/view";

/**
 * Dossier en mode décision (mode poche). Largeurs de téléphone seulement.
 * Les captures sont jointes aux résultats (sur la Preview : artefact « preview-smoke-captures »).
 */
const capture = async (page: Page, nom: string, fullPage = false) => {
  await page.screenshot({ path: test.info().outputPath(`${nom}.png`), fullPage, animations: "disabled" });
  await test.info().attach(nom, { path: test.info().outputPath(`${nom}.png`), contentType: "image/png" });
};
const barre = (page: Page) => page.getByTestId("barre-decision");
const approuver = (page: Page) => barre(page).getByRole("button", { name: /^(Approuver|Retenir l'inaction)$/ });
const rejeter = (page: Page) => barre(page).getByRole("button", { name: "Rejeter la proposition" });
const differer = (page: Page) => barre(page).getByRole("button", { name: "Différer de 3 jours" });
const commentaire = (page: Page) => barre(page).getByLabel(/Commentaire obligatoire/);
/** Titre du résultat après « Approuver » (ou « Retenir l'inaction »). */
const RESULTAT_APPROUVE = /Option approuvée|Inaction retenue/;

/** L'élément tient entre le haut de l'écran et la barre de navigation, sans rien par-dessus. */
async function visibleSansDefiler(page: Page, el: Locator, quoi: string) {
  await expect(el, quoi).toBeVisible();
  const box = (await el.boundingBox())!, nav = (await page.locator(".bottombar").boundingBox())!;
  expect(box.y, quoi).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${quoi} : au-dessus de la barre de navigation`).toBeLessThanOrEqual(nav.y + 0.5);
  const dessus = await el.evaluate((e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
  expect(dessus, `${quoi} : rien ne le recouvre`).toBe(true);
}

/** Adresses des dossiers listés par un écran d'Opportunités. */
async function dossiers(page: Page, url: string): Promise<string[]> {
  await page.goto(url);
  await expect(page.getByTestId("situation").first()).toBeVisible();
  const hrefs = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("#")[0]));
  return [...new Set(hrefs)];
}

/** Premier dossier ouvert dont l'option recommandée s'approuve sans commentaire. */
async function dossierConforme(page: Page): Promise<string> {
  for (const href of await dossiers(page, "/")) {
    await page.goto(href);
    await expect(page.getByTestId("dossier-decision")).toBeVisible();
    if ((await approuver(page).count()) && (await approuver(page).isEnabled()) && !(await commentaire(page).count())) return href;
  }
  throw new Error("la démonstration doit comporter un dossier approuvable sans commentaire");
}

test.describe("Sur téléphone, compte de démonstration", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");

  test("« Approuver » est visible sans défiler ; la décision d'abord, les sections repliées", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    const href = await dossierConforme(page);
    await page.goto(href);
    await visibleSansDefiler(page, approuver(page), "Approuver");
    await visibleSansDefiler(page, rejeter(page), "Rejeter");
    await visibleSansDefiler(page, differer(page), "Différer");
    for (const b of [approuver(page), rejeter(page), differer(page)]) {
      const box = (await b.boundingBox())!;
      expect(Math.min(box.width, box.height), "cible tactile").toBeGreaterThanOrEqual(43.5);
    }
    // la barre de navigation reste visible sous la barre de décision
    const nav = (await page.locator(".bottombar").boundingBox())!, bar = (await barre(page).boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y + 0.5);
    await expect(page.locator(".pk-dossier-head .pk-code")).toContainText(/· PB-\d\d$/);
    await expect(page.getByRole("link", { name: "Retour aux opportunités" })).toHaveAttribute("href", "/");
    await expect(page.getByTestId("pk-resume").locator("dt")).toHaveText(["Signal", "Période", "Hypothèse", "Option recommandée"]);
    await expect(page.getByTestId("pk-jauges")).toContainText(/Confiance[\s\S]*· risque/i);
    // rien n'est déplié sur un dossier à décider, et chaque section a sa place
    await expect(page.locator(".pk-folds > details[open]")).toHaveCount(0);
    for (const id of ["options", "raisonnement", "economie", "cycle", "conversation", "tracabilite"]) await expect(page.getByTestId(`pli-${id}`)).toHaveCount(1);
    await expectNoHorizontalOverflow(page, "dossier en mode décision");
    await capture(page, "poche-dossier");
    await deplierDossier(page);
    await expectNoHorizontalOverflow(page, "dossier déplié");
    // aucune section rognée : ce qui dépasse défile, au lieu d'être coupé
    const rognes = await page.locator(".pk-fold-body *").evaluateAll((els) => els.filter((e) => {
      const s = getComputedStyle(e);
      return ["hidden", "clip"].includes(s.overflowX) && s.textOverflow !== "ellipsis" && !e.closest("caption, h2, h3, svg") && e.tagName !== "IMG" && e.clientWidth > 2 && e.scrollWidth > e.clientWidth + 1;
    }).map((e) => `${e.tagName}.${e.getAttribute("class")}`));
    expect(rognes, "contenu rogné").toEqual([]);
    // en bas de page, rien ne reste sous la barre
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const dernier = page.locator(".pk-dossier > :nth-last-child(2)");
    await expect.poll(async () => { const d = (await dernier.boundingBox())!, b = (await barre(page).boundingBox())!; return d.y + d.height - b.y; }).toBeLessThanOrEqual(0.5);
    await capture(page, "poche-dossier-deplie", true);
    expect(errors, "erreurs JavaScript").toEqual([]);
  });

  test("Dossier sous veto : motif, commentaire exigé, aucun report", async ({ page }) => {
    const [href] = await dossiers(page, "/?u=veto");
    await page.goto(href);
    await expect(page.getByTestId("motif-veto")).toContainText("Motif du veto");
    await expect(page.getByTestId("pk-pastille")).toContainText("Veto économique");
    await expect(differer(page)).toHaveCount(0);
    await expect(approuver(page)).toBeDisabled();
    await expect(rejeter(page)).toBeEnabled();
    await visibleSansDefiler(page, approuver(page), "Approuver");
    await visibleSansDefiler(page, commentaire(page), "commentaire");
    await expect(page.getByTestId("avant-de-decider")).toContainText("Commentaire obligatoire :");
    await expect(page.getByTestId("avant-de-decider")).toContainText("Un dossier sous veto ne peut pas être différé.");
    await expect(async () => {
      await commentaire(page).fill("court");
      await expect(approuver(page)).toBeDisabled();
      await commentaire(page).fill("Plancher confirmé avec le propriétaire");
      await expect(approuver(page)).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    await commentaire(page).fill("        ");
    await expect(approuver(page)).toBeDisabled();
    await expectNoHorizontalOverflow(page, "dossier sous veto");
    await capture(page, "poche-dossier-veto");
  });

  test("« Arbitrer » ouvre le haut du dossier, la barre à l'écran ; un renvoi de preuve ouvre sa section", async ({ page }) => {
    await page.goto("/");
    const arbitrer = page.getByRole("link", { name: "Arbitrer" }).first();
    await arbitrer.click();
    await expect(page).toHaveURL(/\/dossier\/.+#decision$/);
    await expect(barre(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    await visibleSansDefiler(page, rejeter(page), "Rejeter");
    // adresse directe
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    // ancre vers une pièce rangée dans une section repliée
    await page.goto(`${new URL(page.url()).pathname}#preuve-E1`);
    await page.reload();
    await expect(page.getByTestId("pli-raisonnement")).toHaveAttribute("open", "");
    await expect(page.locator("#preuve-E1")).toBeInViewport();
  });

  test("Sections dépliées : le même contenu qu'en version complète", async ({ page }) => {
    const ids = ["frise-h", "lies-h", "raison-h", "options-h", "eco-h", "suivi-h", "transitions-h", "trace-h", "talk-h", "who-h"];
    const lire = () => page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
      const s = document.querySelector(`section[aria-labelledby="${id}"]`);
      return [id, s ? (s.textContent ?? "").replace(/\s+/g, " ").trim() : null];
    })), ids);
    await page.goto("/historique");
    const tranches = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")!))]);
    expect(tranches.length, "dossiers de l'historique de démonstration").toBeGreaterThan(0);
    const ouverts = await dossiers(page, "/");
    const comparees = new Set<string>();
    // des dossiers de l'historique (action, transitions, repos) et des dossiers ouverts
    for (const href of [...tranches.slice(0, 4), ...ouverts.slice(0, 3)]) {
      // compte partagé : un autre test peut ajouter un message ou une trace entre les deux lectures, d'où la reprise
      await expect(async () => {
        await page.context().clearCookies({ name: "ns_vue" });
        await page.goto(href);
        await expect(page.getByTestId("dossier-decision")).toBeVisible();
        const compact = await lire();
        const synthese = (await page.getByTestId("synthese").textContent())!.replace(/\s+/g, " ").trim();
        await versionComplete(page.context());
        await page.goto(href);
        await expect(page.locator("ol.frieze")).toBeVisible();
        await expect(page.getByTestId("dossier-decision")).toHaveCount(0);
        const complet = await lire();
        expect(compact, href).toEqual(complet);
        for (const id of ids) if (complet[id]) comparees.add(id);
        for (const id of ["frise-h", "raison-h", "options-h", "trace-h", "talk-h", "who-h"]) expect(complet[id], `${href} ${id}`).toBeTruthy();
        expect((await page.locator(".content").textContent())!.replace(/\s+/g, " "), `${href} synthèse`).toContain(synthese);
      }).toPass({ timeout: 40_000 });
    }
    expect([...comparees].sort(), "chaque section a été comparée au moins une fois").toEqual([...ids].sort());
  });

  test("Un renvoi de preuve touché hors de sa section l'ouvre, même une seconde fois", async ({ page }) => {
    const [href] = await dossiers(page, "/");
    await page.goto(href);
    const options = page.getByTestId("pli-options"), preuves = page.getByTestId("pli-raisonnement");
    await options.locator(":scope > summary").click();
    // les données de démonstration ne portent pas toujours de renvoi dans les options (seconde lecture) : le test en pose un, comme celui qu'elle écrit
    await options.locator(":scope > .pk-fold-body").evaluate((el) => el.insertAdjacentHTML("afterbegin", '<a class="preuve-link" data-testid="renvoi-test" href="#preuve-E1">E1</a>'));
    for (const fois of ["première", "seconde"]) {
      await expect(preuves).not.toHaveAttribute("open", "");
      await page.getByTestId("renvoi-test").click();
      await expect(preuves, `${fois} fois`).toHaveAttribute("open", "");
      await expect(page.locator("#preuve-E1")).toBeInViewport();
      await preuves.locator(":scope > summary").click();
    }
  });
});

// Les décisions modifient les données : un espace propre au test, avec sa propre démonstration.
test.describe("Sur téléphone, décider depuis le dossier", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");
  test.skip(!hasDatabase(), "DATABASE_URL absent : espace de test non créable sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });

  let tenant = "", drop = async () => {};
  test.beforeEach(async ({ page }, info) => {
    ({ tenant, drop } = await loginNewTenant(page, info, "Test poche dossier"));
    await versionComplete(page.context());
    await page.goto("/parametres/demo");
    await page.getByRole("button", { name: "Réinstaller la démonstration à la date du jour" }).click();
    await expect(page.getByText("Démonstration réinstallée à la date du jour.")).toBeVisible({ timeout: 30_000 });
    await page.context().clearCookies({ name: "ns_vue" });
  });
  test.afterEach(() => drop());

  type Option = { type: string; label: string; risk: string; audit: { verdict: string } };
  type Dossier = { id: string; code: string; playbook: string; veto: boolean; selected: number; candidates: Option[] };
  const ouverts = async (): Promise<Dossier[]> => (await sql("select id, code, playbook, veto, selected, candidates from opportunities where tenant_id = $1 and status = 'OPEN' order by code", [tenant])).rows;
  const etat = async (code: string) => (await sql("select status, decision, selected from opportunities where tenant_id = $1 and code = $2", [tenant, code])).rows[0];
  const veto = async () => (await ouverts()).find((o) => o.veto)!;
  /** Dossier ouvert, sans veto, dont l'option recommandée est une action qui s'approuve sans commentaire. */
  async function conforme(page: Page): Promise<Dossier> {
    for (const o of (await ouverts()).filter((o) => !o.veto && o.candidates[o.selected].type !== "NO_ACTION")) {
      await page.goto(`/dossier/${o.code}`);
      await expect(page.getByTestId("dossier-decision")).toBeVisible();
      if ((await approuver(page).isEnabled()) && !(await commentaire(page).count())) return o;
    }
    throw new Error("la démonstration doit comporter un dossier approuvable sans commentaire");
  }

  test("Après un geste fait en bas de page, le résultat revient à l'écran", async ({ page }) => {
    const o = await conforme(page);
    await deplierDossier(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByRole("heading", { level: 1 })).not.toBeInViewport();
    await differer(page).click();
    await expect(page.locator("#pk-outcome")).toContainText("Dossier différé jusqu'au");
    await expect(page.locator("#pk-outcome")).toBeInViewport();
    await expect(page.locator("#pk-outcome")).toBeFocused();
    expect((await etat(o.code)).status).toBe("DEFERRED");
    await barre(page).getByRole("button", { name: "Rouvrir le dossier" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  });

  test("Approbation d'une option conforme : résultat sous le titre, suivi d'application ouvert", async ({ page }) => {
    const o = await conforme(page);
    await approuver(page).click();
    await expect(page.locator("#pk-outcome")).toContainText("Option approuvée");
    await expect(approuver(page)).toHaveCount(0);
    expect(await etat(o.code)).toMatchObject({ status: "DECIDED", decision: "APPROVED" });
    await expect(page.getByTestId("pli-suivi")).toHaveAttribute("open", "");
    await expect(barre(page)).toHaveCount(0);
    await expect(page.getByTestId("avant-de-decider")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "dossier approuvé");
    await capture(page, "poche-dossier-approuve", true);
  });

  test("Veto : le serveur refuse un commentaire vide même si le bouton est forcé ; avec commentaire, la décision passe", async ({ page }) => {
    const o = await veto();
    await page.goto(`/dossier/${o.code}`);
    await expect(approuver(page)).toBeDisabled();
    await expect(async () => {
      await approuver(page).evaluate((b: HTMLButtonElement) => { b.disabled = false; b.click(); });
      await expect(barre(page).getByRole("alert")).toContainText("Un commentaire est obligatoire", { timeout: 3_000 });
    }).toPass();
    expect((await etat(o.code)).status).toBe("OPEN");
    await visibleSansDefiler(page, barre(page).getByRole("alert"), "refus du serveur");
    await visibleSansDefiler(page, approuver(page), "Approuver après le refus");
    await capture(page, "poche-dossier-refus");
    await commentaire(page).fill("Plancher confirmé avec le propriétaire");
    await approuver(page).click();
    // le résultat affiché signe la fin de l'action serveur ; le bouton, lui, change de libellé dès l'envoi (« En cours… »)
    await expect(page.locator("#pk-outcome")).toContainText(RESULTAT_APPROUVE);
    await expect(approuver(page)).toHaveCount(0);
    expect((await etat(o.code)).status).toBe("DECIDED");
    const trace = await sql("select payload->>'comment' as comment from audit_events where tenant_id = $1 and type in ('action.approved', 'opportunity.no_action') and payload->>'code' = $2", [tenant, o.code]);
    expect(trace.rows.map((r) => r.comment)).toContain("Plancher confirmé avec le propriétaire");
  });

  test("Rejet avec commentaire consigné, puis réouverture ; différer, puis rouvrir", async ({ page }) => {
    const o = await veto();
    await page.goto(`/dossier/${o.code}`);
    await expect(async () => {
      await commentaire(page).fill("Le plancher doit d'abord être revu");
      await expect(approuver(page)).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    await rejeter(page).click();
    await expect(page.getByTestId("dossier-decision")).toContainText("Proposition rejetée");
    expect((await etat(o.code)).decision).toBe("REJECTED");
    const trace = await sql("select payload->>'comment' as comment from audit_events where tenant_id = $1 and type = 'opportunity.rejected' and payload->>'code' = $2", [tenant, o.code]);
    expect(trace.rows[0].comment).toBe("Le plancher doit d'abord être revu");
    await barre(page).getByRole("button", { name: "Rouvrir le dossier" }).click();
    await expect(approuver(page)).toBeVisible();
    await expect(commentaire(page)).toHaveValue("");
    expect((await etat(o.code)).status).toBe("OPEN");

    const autre = (await ouverts()).find((x) => !x.veto)!;
    await page.goto(`/dossier/${autre.code}`);
    await differer(page).click();
    await expect(page.getByTestId("dossier-decision")).toContainText("Dossier différé jusqu'au");
    expect((await etat(autre.code)).status).toBe("DEFERRED");
    await expect(approuver(page)).toHaveCount(0);
    await visibleSansDefiler(page, barre(page).getByRole("button", { name: "Rouvrir le dossier" }), "Rouvrir");
    await capture(page, "poche-dossier-differe");
    await barre(page).getByRole("button", { name: "Rouvrir le dossier" }).click();
    await expect(differer(page)).toBeVisible();

    // expiré : le résultat, aucun bouton
    await sql("update opportunities set status = 'EXPIRED' where tenant_id = $1 and code = $2", [tenant, autre.code]);
    await page.reload();
    await expect(page.getByTestId("dossier-decision")).toContainText("Dossier expiré");
    await expect(barre(page)).toHaveCount(0);
  });

  test("Option rejetée par l'auditeur : jamais approuvable, le motif est rattaché au bouton", async ({ page }) => {
    const liste = await ouverts();
    const avecRejet = liste.find((o) => o.candidates.some((c) => c.audit.verdict === "REJECT"))!;
    const rejetee = avecRejet.candidates.findIndex((c) => c.audit.verdict === "REJECT");
    await page.goto(`/dossier/${avecRejet.code}?option=${rejetee}`);
    await expect(page.getByTestId("pk-pastille")).toContainText("Option rejetée");
    await expect(approuver(page)).toBeDisabled();
    await expect(approuver(page)).toHaveAccessibleDescription(/rejetée par l'auditeur/i);
    await expect(commentaire(page)).toHaveCount(0);
    await expect(rejeter(page)).toBeEnabled();
    await capture(page, "poche-dossier-rejetee");
  });

  test("« Examiner cette option » ramène en haut, vide le commentaire, et la barre agit sur l'option affichée", async ({ page }) => {
    // dossier sous veto : chacune de ses options approuvables exige un commentaire
    const o = await veto();
    const alt = o.candidates.findIndex((c, i) => i !== o.selected && c.audit.verdict !== "REJECT" && c.type !== "NO_ACTION");
    expect(alt, "la démonstration doit proposer une autre option approuvable sur le veto").toBeGreaterThanOrEqual(0);
    await page.goto(`/dossier/${o.code}`);
    await expect(async () => {
      await commentaire(page).fill("Écrit pour la première option");
      await expect(approuver(page)).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    const pli = page.getByTestId("pli-options");
    await pli.locator(":scope > summary").click();
    await pli.locator(`a[href="/dossier/${o.code}?option=${alt}"]`).click();
    await expect(page).toHaveURL(new RegExp(`\\?option=${alt}$`));
    await expect(page.getByTestId("pk-resume")).toContainText("Option examinée");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5);
    await expect(page.getByRole("link", { name: "Revenir à l'option recommandée" })).toBeVisible();
    await expect(commentaire(page)).toHaveValue("");
    await expect(approuver(page)).toBeDisabled();
    await commentaire(page).fill("Option alternative retenue après examen");
    await approuver(page).click();
    await expect(page.locator("#pk-outcome")).toContainText(RESULTAT_APPROUVE);
    await expect(approuver(page)).toHaveCount(0);
    expect(await etat(o.code)).toMatchObject({ status: "DECIDED", selected: alt });
    const action = await sql("select a.approval_comment from revenue_actions a join opportunities op on op.id = a.opportunity_id where op.tenant_id = $1 and op.code = $2", [tenant, o.code]);
    expect(action.rows[0].approval_comment).toBe("Option alternative retenue après examen");
  });

  test("Une inaction seulement examinée n'est pas dite recommandée", async ({ page }) => {
    const o = (await ouverts()).find((o) => !o.veto && !["PB-10", "PB-13"].includes(o.playbook) && o.candidates[o.selected].type !== "NO_ACTION" && o.candidates.some((c) => c.type === "NO_ACTION" && c.audit.verdict !== "REJECT"))!;
    expect(o, "la démonstration doit comporter une inaction non recommandée").toBeTruthy();
    await page.goto(`/dossier/${o.code}?option=${o.candidates.findIndex((c) => c.type === "NO_ACTION" && c.audit.verdict !== "REJECT")}`);
    await expect(page.getByTestId("pk-pastille")).toHaveText("Inaction examinée");
    await expect(approuver(page)).toHaveText("Retenir l'inaction");
  });
});

test.describe("Sur téléphone, sans le droit de décider", () => {
  test.skip(({ isMobile }) => !isMobile, "mode poche : largeurs de téléphone");
  test.skip(!hasDatabase(), "DATABASE_URL absent : compte de test non créable sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Lecture seule : dite sous le titre, sans barre de décision", async ({ page }) => {
    const u = await createRoleUser("OWNER_VIEWER", `${test.info().project.name.replace(/\W/g, "")}-${Date.now().toString(36)}`);
    try {
      await page.goto("/connexion");
      await page.getByLabel("Adresse e-mail").fill(u.email);
      await page.getByLabel("Mot de passe").fill(u.password);
      await page.getByRole("button", { name: "Se connecter" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
      const [href] = await dossiers(page, "/");
      await page.goto(href);
      await expect(page.getByTestId("lecture-seule")).toContainText("ne permet pas de décider");
      await expect(page.getByTestId("lecture-seule")).toBeInViewport();
      await expect(barre(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Approuver|Rejeter|Différer|Retenir/ })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "dossier en lecture seule");
      await capture(page, "poche-dossier-lecture");
    } finally { await deleteUser(u.id); }
  });
});

// La version allégée peut être demandée sur une tablette ou un ordinateur : la barre se cale sur la colonne du dossier, rien n'est masqué.
test.describe("Version allégée sur écran large", () => {
  test.skip(({ isMobile }) => isMobile, "largeurs de tablette et d'ordinateur");

  for (const width of [768, 1280, 1920]) {
    test(`Barre de décision à ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.context().addCookies([{ name: "ns_vue", value: "poche", url: test.info().project.use.baseURL! }]);
      await page.goto(await dossierConforme(page));
      await expect(approuver(page)).toBeInViewport();
      const colonne = (await page.getByTestId("dossier-decision").boundingBox())!;
      const gestes = (await barre(page).locator(".pk-bar-inner").boundingBox())!;
      expect(Math.abs(colonne.x - gestes.x), "barre alignée sur la colonne").toBeLessThanOrEqual(2);
      expect(Math.abs(colonne.width - gestes.width), "même largeur que la colonne").toBeLessThanOrEqual(2);
      await expectNoHorizontalOverflow(page, `version allégée à ${width} px`);
      await deplierDossier(page);
      await expectNoHorizontalOverflow(page, `dossier déplié à ${width} px`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const dernier = page.locator(".pk-dossier > :nth-last-child(2)");
      await expect.poll(async () => { const d = (await dernier.boundingBox())!, b = (await barre(page).boundingBox())!; return d.y + d.height - b.y; }).toBeLessThanOrEqual(0.5);
      await capture(page, `poche-dossier-${width}`);
    });
  }
});

import { expect, test, type Page } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { colonnesEcrasees, expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";

// Régressions de mise en page relevées par un audit de tous les écrans : texte coupé dans le calendrier, colonnes écrasées sur téléphone.
// Sur le projet bureau, les mêmes écrans sont aussi contrôlés aux largeurs de tablette et de petit ordinateur.

/** Largeurs à contrôler : celle du projet, plus tablette et petit ordinateur sur le projet bureau. */
async function aChaqueLargeur(page: Page, controle: (largeur: number) => Promise<void>) {
  const propre = page.viewportSize()!;
  for (const largeur of propre.width >= 1024 ? [propre.width, 1024, 768] : [propre.width]) {
    await page.setViewportSize({ width: largeur, height: propre.height });
    await controle(largeur);
  }
  await page.setViewportSize(propre);
}

const deplier = (page: Page) => page.locator(".content details:not(.term):not(:has([role=menu]))").evaluateAll((els) => els.forEach((d) => ((d as HTMLDetailsElement).open = true)));

async function liens(page: Page, depuis: string, motif: RegExp): Promise<string[]> {
  await page.goto(depuis);
  const hrefs = await page.locator(".content a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split(/[?#]/)[0]));
  const trouves = Array.from(new Set(hrefs.filter((h) => motif.test(h)))).sort();
  expect(trouves.length, `liens attendus sur ${depuis}`).toBeGreaterThan(0);
  return trouves;
}
const dossiers = (page: Page) => liens(page, "/", /^\/dossier\/S-/);

/** Cases du calendrier où un texte sort de sa case, ou dont un mot est coupé en deux lignes. Seule l'espace ordinaire autorise le passage à la ligne. */
const malTenus = (page: Page) => page.locator("a.cal-day").evaluateAll((cases) => cases.flatMap((c) => {
  const boite = c.getBoundingClientRect(), largeur = Math.round(boite.width);
  return Array.from(c.children).flatMap((s) => {
    const r = document.createRange(); r.selectNodeContents(s);
    const t = r.getBoundingClientRect();
    if (t.left < boite.left - 0.5 || t.right > boite.right + 0.5) return [`« ${s.textContent} » sort d'une case de ${largeur} px`];
    const texte = s.textContent!, noeud = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    const morceaux: Text[] = []; for (let n = noeud.nextNode(); n; n = noeud.nextNode()) morceaux.push(n as Text);
    // le texte d'une case peut être réparti sur plusieurs nœuds : chaque nœud est examiné mot par mot
    return morceaux.flatMap((n) => Array.from(n.data.matchAll(/[^ ]+/g)).flatMap((m) => {
      r.setStart(n, m.index!); r.setEnd(n, m.index! + m[0].length);
      const lignes = new Set(Array.from(r.getClientRects(), (x) => Math.round(x.top)));
      return lignes.size > 1 ? [`« ${m[0]} » (de « ${texte} ») coupé dans une case de ${largeur} px`] : [];
    }));
  });
}).slice(0, 10));

test.describe("version complète", () => {
  test.use(VERSION_COMPLETE);

  test("calendrier : dates, prix et occupation tiennent dans leur case, sans mot coupé", async ({ page }) => {
    // les logements de démonstration seulement : d'autres tests créent et suppriment des logements pendant ce temps
    const liste = (await (await page.request.get("/api/v1/properties")).json()).properties as { id: string; isDemo: boolean }[];
    const logements = liste.filter((p) => p.isDemo).map((p) => `/logements/${p.id}`).sort();
    expect(logements.length, "logements de démonstration").toBeGreaterThan(0);
    // valeurs les plus longues possibles, écrites comme le calendrier les compose : espace insécable dans un nombre et avant « % »
    const longues = [["bloqué", "m. 100 % ★"], ["~1 250 €", "m. ?"]];
    for (const logement of logements.slice(0, 2)) {
      await page.goto(`${logement}?tab=calendrier`, { waitUntil: "networkidle" });
      const cases = page.locator("a.cal-day");
      await expect(cases.first()).toBeVisible();
      // ajout dans la page seulement : aucune donnée n'est modifiée
      for (const [i, [prix, marche]] of longues.entries()) await cases.nth(i).evaluate((c, [p, m]) => { c.querySelector(".p")!.textContent = p; c.querySelector(".m")!.textContent = m; }, [prix, marche]);
      await aChaqueLargeur(page, async (l) => {
        expect(await malTenus(page), `${logement} à ${l} px`).toEqual([]);
        await expectNoHorizontalOverflow(page, `calendrier à ${l} px`);
      });
      // les valeurs ajoutées étaient bien en place pendant les mesures
      for (const [i, [prix]] of longues.entries()) expect(await cases.nth(i).locator(".p").textContent()).toBe(prix);
    }
  });

  test("cartes d'opportunité : le titre garde une largeur lisible à côté de la signature", async ({ page }) => {
    await dossiers(page);
    await aChaqueLargeur(page, async (l) => expect(await colonnesEcrasees(page, ".sit-title", 200), `accueil à ${l} px`).toEqual([]));
  });

  test("dossier : titres des options et libellés des preuves lisibles", async ({ page }) => {
    const urls = await dossiers(page);
    test.setTimeout(30_000 + urls.length * 8_000);
    for (const url of urls) {
      await page.goto(url);
      await deplier(page);
      await aChaqueLargeur(page, async (l) => {
        expect(await colonnesEcrasees(page, ".option-head > .od-fill", 200), `${url} à ${l} px, options`).toEqual([]);
        expect(await colonnesEcrasees(page, ".evidence .block dt", 120), `${url} à ${l} px, preuves`).toEqual([]);
        await expectNoHorizontalOverflow(page, `${url} à ${l} px`);
      });
    }
  });

  test("bilan et fiche agent : une seule colonne de blocs sur téléphone", async ({ page }) => {
    for (const url of ["/bilan", "/equipe/distribution"]) {
      await page.goto(url);
      await aChaqueLargeur(page, async (l) => {
        expect(await colonnesEcrasees(page, ".blocks > .block", l < 768 ? l - 60 : 200), `${url} à ${l} px`).toEqual([]);
        await expectNoHorizontalOverflow(page, `${url} à ${l} px`);
      });
    }
  });

  test("historique : le nom de chaque action reste lisible dans le tableau", async ({ page }) => {
    await page.goto("/historique");
    await aChaqueLargeur(page, async (l) => expect(await colonnesEcrasees(page, 'table.hist-actions th[scope="row"] a', 160), `historique à ${l} px`).toEqual([]));
  });
});

test("dossier tel qu'un téléphone le reçoit : titres des options lisibles", async ({ page, isMobile }) => {
  test.skip(!isMobile, "version servie aux téléphones");
  const urls = await dossiers(page);
  await page.goto(urls[0]);
  await deplier(page);
  expect(await colonnesEcrasees(page, ".option-head > .od-fill", 200), urls[0]).toEqual([]);
});

async function verifierPageIntrouvable(page: Page) {
  const reponse = await page.goto("/adresse-qui-n-existe-pas");
  expect(reponse?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Cette adresse n'existe pas");
  await expect(page.getByRole("link", { name: "Retour à l'accueil" })).toHaveAttribute("href", "/");
  await expectNoHorizontalOverflow(page, "page introuvable");
}

test("adresse inconnue : le message ne parle pas d'un dossier", async ({ page }) => {
  await verifierPageIntrouvable(page);
});

test("adresse inconnue sans être connecté : même message", async ({ browser, baseURL }, info) => {
  const contexte = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials, viewport: info.project.use.viewport });
  await verifierPageIntrouvable(await contexte.newPage());
  await contexte.close();
});

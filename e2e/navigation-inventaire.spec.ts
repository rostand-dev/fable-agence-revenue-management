import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { hasDatabase } from "./helpers/roles";

/**
 * Inventaire des écrans : aucun écran ne doit disparaître quand la navigation change.
 * 1. chaque page de l'application est inscrite ici (contrôle sur les fichiers `page.tsx`) ;
 * 2. chaque écran répond ;
 * 3. chaque écran s'atteint depuis l'accueil en 3 clics au plus, sur ordinateur, tablette et mobile. Tout geste compte : suivre un lien (1),
 *    mais aussi déplier une rubrique de la colonne, ouvrir la feuille « Plus » ou un sous-menu de la rangée tablette, la feuille des sections
 *    d'une fiche ou un bloc replié (1 de plus chacun). Les gestes réels de ces feuilles sont vérifiés dans navigation-menu.spec.ts et fiche-hubs.spec.ts.
 */
const MAX_CLICS = 3;

/** `route` : motif du fichier page.tsx ; `tab` : onglet. `needs` : donnée sans laquelle l'écran n'existe pas. */
type Screen = { route: string; tab?: string; needs?: "propriete" | "brouillon" | "dossier" | "rapport" };
const P = "/logements/[id]";
const SCREENS: Screen[] = [
  { route: "/" }, { route: "/portefeuille" }, { route: "/alertes" }, { route: "/logements" }, { route: "/logements/nouveau" },
  { route: "/bilan" }, { route: "/rapports" }, { route: "/historique" }, { route: "/equipe" }, { route: "/equipe/[id]" },
  { route: "/methode" }, { route: "/glossaire" }, { route: "/proprietaires" }, { route: "/integrations" }, { route: "/integrations/erreurs" },
  { route: "/modeles" }, { route: "/modeles/cles" }, { route: "/modeles/agents" }, { route: "/modeles/budget" }, { route: "/modeles/catalogue" }, { route: "/parametres" }, { route: "/parametres/compte" }, { route: "/parametres/priorisation" }, { route: "/parametres/demo" },
  { route: "/dossier/[code]", needs: "dossier" }, { route: "/rapports/[id]", needs: "rapport" },
  { route: P }, ...["performance", "calendrier", "hub-strategie", "strategie", "canaux", "hub-economie", "economie", "hub-donnees", "donnees", "annonces", "pricelabs", "superhote", "historique"].map((tab) => ({ route: P, tab })),
  { route: `${P}/creation`, needs: "brouillon" },
  ...["modifier", "supprimer", "mapping", "qualite", "validations", "couts", "strategie", "compilateur", "saisons", "versions-economie", "ecarts-reservations"].map((s) => ({ route: `${P}/${s}`, needs: "propriete" as const })),
];
const keyOf = (s: Screen) => s.route + (s.tab ? `?tab=${s.tab}` : "");

/** Pages présentes dans le code (hors connexion et inscription, qui ne sont pas dans le menu). */
function routesDuCode(): string[] {
  const out: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), e.name.startsWith("(") ? route : `${route}/${e.name}`);
      else if (e.name === "page.tsx") out.push(route || "/");
    }
  };
  for (const g of ["(app)", "(funnel)"]) walk(join(process.cwd(), "src/app", g), "");
  return out;
}

test("Inventaire : chaque page de l'application est connue du test de navigation", () => {
  const connues = new Set(SCREENS.map((s) => s.route));
  expect(routesDuCode().filter((r) => !connues.has(r)), "pages à ajouter à l'inventaire").toEqual([]);
});

/** Logement réel (en observation) et brouillon, propres à ce test : certains écrans n'existent pas sur un logement de démonstration. */
async function seed(page: Page, tag: string, ids: string[]) {
  await purge();
  for (const kind of ["reel", "brouillon"]) {
    const res = await page.request.post("/api/v1/properties", { data: { name: `Inventaire ${kind} ${tag}`, city: "Lille", kind: "T2", bedrooms: 2, capacity: 4 } });
    expect(res.status(), await res.text()).toBe(201);
    ids.push((await res.json()).id as string);
  }
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    // le logement réel est daté « dans le futur » : il reste parmi les logements récents du menu même quand d'autres tests en créent en parallèle
    // (un par largeur, tablette comprise, soit quatre au plus pour cinq places)
    await c.query("update properties set created_at = now() + interval '1 day' where id = $1", [ids[0]]);
    // modèle économique complet et rapprochement avec un écart : les liens « saisons » et « écarts » n'apparaissent qu'à cette condition
    const economics = { origin: "OWNER", channels: { AIRBNB: { commissionPct: 3, paymentFeePct: 0 }, BOOKING: { commissionPct: 15, paymentFeePct: 0 } }, cleaningFeeChargedCents: 4000, cleaningCostCents: 3500, linenCostCents: 800,
      nightlyVariableCostCents: 500, hardContributionPerNightCents: 1000, strategyContributionPerNightCents: 2000, targetContributionPerNightCents: 3000 };
    const reservationCheck = { compared: 3, onlySuperhote: 0, onlyPriceLabs: 0, amountDiffs: 1, items: [] };
    const superhote = { apiKeyEnc: "x", keyHint: "…e2e", rentalId: `inv-${ids[0]}`, rentalName: "Annonce E2E", lastSync: { ok: true, at: new Date().toISOString(), reservations: 3, nights: 9, autoChannels: 0, observedCommissions: {}, reservationCheck } };
    await c.query("update properties set status = 'SHADOW', economics = $2::jsonb, economics_version = 1, superhote = $3::jsonb, pricelabs = $4::jsonb where id = $1", [ids[0], JSON.stringify(economics), JSON.stringify(superhote), JSON.stringify({ apiKeyEnc: "x", listingId: `inv-${ids[0]}`, listingName: "Annonce E2E" })]);
  } finally { await c.end(); }
  return { reel: ids[0], brouillon: ids[1] };
}
/** Mois terminé, `offset` mois en arrière : chaque largeur a le sien, distinct de ceux de rapports-mensuels.spec.ts. */
function monthValue(offset: number): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
/** Un brouillon de rapport, sans lequel l'écran d'un rapport n'existe pas. */
async function prepareRapport(page: Page, mois: string) {
  await page.goto("/rapports");
  await page.getByLabel("Mois à rapporter").selectOption(mois);
  await page.getByRole("button", { name: "Préparer ou actualiser le rapport" }).click();
  await expect(page.getByText("Rapport préparé")).toBeVisible();
}
async function removeRapport(mois: string) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  // brouillons des logements de démonstration seulement : rien de réel n'est touché
  try { await c.query("delete from monthly_reports where month = $1 and status = 'DRAFT' and property_id in (select id from properties where is_demo)", [mois]); } finally { await c.end(); }
}
/** Restes d'un essai interrompu : logements de ce test vieux de plus d'une heure (le logement réel est daté un jour plus tard). */
async function purge() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("delete from properties where name like 'Inventaire %' and (created_at < now() - interval '1 hour' or created_at between now() and now() + interval '23 hours')"); } finally { await c.end(); }
}
async function remove(ids: string[]) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("delete from properties where id = any($1)", [ids]); } finally { await c.end(); }
}

type Lien = { href: string; gestes: number };
/** Liens que la personne peut suivre (menu adapté à la largeur et contenu de la page), avec le nombre de gestes nécessaires avant de pouvoir toucher chacun. */
async function liens(page: Page): Promise<Lien[]> {
  return page.evaluate(() => {
    const w = window.innerWidth;
    const menus = w >= 1024 ? [".rail"] : w >= 768 ? [".navbar", ".nav-sheet"] : [".bottombar", ".nav-sheet"];
    const sel = [...menus, ".content", ".fn"].map((s) => `${s} a[href]`).join(",");
    /** Un geste par élément replié à ouvrir : branche de la colonne, feuille, bloc dépliable. Null : lien impossible à montrer. */
    const gestes = (a: HTMLAnchorElement): number | null => {
      const touchable = (el: Element | null | undefined) => {
        if (!el || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
        const r = el.getBoundingClientRect();
        return r.right > 0 && r.left < w;
      };
      const feuille = a.closest("dialog.nav-sheet");
      if (feuille) {
        const sections = !!feuille.closest(".section-switcher");
        if (sections && w >= 1024) return null;
        // tablette : le chevron d'une rubrique ouvre sa feuille déjà dépliée ; mobile : « Plus » puis, au besoin, la rubrique
        if (!sections && w >= 768) {
          const titre = a.closest("details")?.querySelector("summary > span:not([data-icon]):not([class])")?.textContent;
          const ouvre = Array.from(document.querySelectorAll(".navbar button")).find((b) => b.getAttribute("aria-label") === `Sous-menu ${titre}` || b.textContent?.trim() === titre);
          return touchable(ouvre) ? 1 : null;
        }
        const declencheur = sections ? feuille.parentElement?.querySelector(".section-switcher-btn") : Array.from(document.querySelectorAll(".bottombar button")).at(-1);
        if (!touchable(declencheur)) return null;
        const bloc = a.closest("details");
        return bloc && !bloc.open ? 2 : 1;
      }
      let n = 0;
      for (let el: HTMLElement | null = a.parentElement; el; el = el.parentElement) {
        // le titre d'un bloc replié reste touchable ; son contenu demande de l'ouvrir
        if (el instanceof HTMLDetailsElement && !el.open && a.closest("summary")?.parentElement !== el) n++;
        else if (el.matches("ul.rail-sub[hidden]")) n++;
        else if (el.hidden) return null;
      }
      // lien masqué à cette largeur (autre présentation du même menu) : on ne le compte pas
      if (n === 0 && !touchable(a)) return null;
      return n;
    };
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(sel)).flatMap((a) => {
      const href = a.getAttribute("href")!, g = href.startsWith("/") ? gestes(a) : null;
      return g === null ? [] : [{ href, gestes: g }];
    });
  });
}

test("Inventaire : chaque écran répond et s'atteint depuis l'accueil en 3 clics au plus", async ({ page }, info) => parcours(page, info.project.name));
test("Inventaire (tablette) : chaque écran s'atteint depuis l'accueil en 3 clics au plus à 768 px", async ({ page }, info) => {
  test.skip(info.project.name !== "bureau", "une seule passe à 768 px");
  await page.setViewportSize({ width: 768, height: 1024 });
  await parcours(page, "tablette");
});
async function parcours(page: Page, largeur: string) {
  test.setTimeout(240_000);
  const db = hasDatabase();
  const ids: string[] = [];
  const mois = monthValue(({ bureau: 8, tablette: 9, "mobile-390": 10, "mobile-360": 11 } as Record<string, number>)[largeur] ?? 12);
  try {
    const own = db ? await seed(page, `${largeur}-${Date.now().toString(36)}`, ids) : null;
    if (db) await prepareRapport(page, mois);
    // on ne suit que les logements de démonstration et les nôtres : ceux des autres tests peuvent disparaître en cours de parcours
    await page.goto("/logements");
    const demos = await page.locator('.content a[href^="/logements/"]:has(.demo-pill)').evaluateAll((as) => as.map((a) => a.getAttribute("href")!.split("/")[2]));
    /** Motif d'écran d'un lien ; null : écran hors inventaire ou logement d'un autre test (inutile à parcourir). */
    const classify = (href: string): string | null => {
      const u = new URL(href, "http://x");
      const parts = u.pathname.split("/").filter(Boolean);
      const [a, b, c] = parts;
      let route = u.pathname;
      if (a === "logements" && b && b !== "nouveau") {
        if (!demos.includes(b) && b !== own?.reel && b !== own?.brouillon) return null;
        if (own && c === "creation" && b !== own.brouillon) return null;
        if (own && c !== "creation" && b === own.brouillon) return null;
        route = c ? `${P}/${c}` : P;
      } else if (a === "dossier" && b) route = "/dossier/[code]";
      else if (a === "equipe" && b) route = "/equipe/[id]";
      else if (a === "rapports" && b) route = "/rapports/[id]";
      const tab = route === P ? u.searchParams.get("tab") : null;
      const key = route + (tab && tab !== "apercu" ? `?tab=${tab}` : "");
      return SCREENS.some((s) => keyOf(s) === key) ? key : null;
    };
    const depth = new Map<string, number>([["/", 0]]);
    // un écran peut être visité sur un logement de démonstration puis sur le nôtre : leurs liens diffèrent
    const visited = new Set<string>();
    // parcours par nombre de gestes croissant : un lien peut en coûter plusieurs, il rejoint alors une file plus lointaine
    const files = new Map<number, string[]>([[0, ["/"]]]);
    for (let d = 0; d < MAX_CLICS; d++) {
      for (const href of files.get(d) ?? []) {
        const k0 = classify(href) ?? href;
        const visit = `${k0}|${own && href.includes(own.reel) ? "sien" : "autre"}`;
        if (visited.has(visit)) continue;
        visited.add(visit);
        const res = await page.goto(href);
        expect(res?.status(), `${href} : statut HTTP`).toBeLessThan(400);
        await expect(page).not.toHaveURL(/\/connexion/);
        for (const l of await liens(page)) {
          const k = classify(l.href);
          const total = d + 1 + l.gestes;
          if (!k || total > MAX_CLICS) continue;
          if (total < (depth.get(k) ?? Infinity)) depth.set(k, total);
          if (total < MAX_CLICS) files.set(total, [...(files.get(total) ?? []), l.href]);
        }
      }
    }
    const manquants: string[] = [];
    for (const s of SCREENS) {
      // données absentes (environnement distant) : logement réel non créable, ou aucun rapport préparé
      if (!db && (s.needs === "propriete" || s.needs === "brouillon")) continue;
      if (!db && s.needs === "rapport" && !depth.has(keyOf(s))) continue;
      if (!depth.has(keyOf(s))) manquants.push(keyOf(s));
    }
    expect(manquants, `écrans hors de portée en ${MAX_CLICS} clics`).toEqual([]);
  } finally {
    try { if (ids.length) await remove(ids); } finally { if (db) await removeRapport(mois); }
  }
}

test("Inventaire : les écrans à onglet répondent aussi quand on les ouvre directement", async ({ page }) => {
  await page.goto("/logements");
  const href = (await page.locator('.content a[href^="/logements/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!))).find((h) => /^\/logements\/[^/]+$/.test(h) && !h.endsWith("/nouveau"));
  expect(href, "aucun logement à ouvrir").toBeTruthy();
  for (const s of SCREENS.filter((x) => x.tab)) {
    const res = await page.goto(`${href}?tab=${s.tab}`);
    expect(res?.status(), `${s.tab}`).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeVisible();
  }
});

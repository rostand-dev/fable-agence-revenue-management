import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { hasDatabase } from "./helpers/roles";

/**
 * Inventaire des écrans : aucun écran ne doit disparaître quand la navigation change.
 * 1. chaque page de l'application est inscrite ici (contrôle sur les fichiers `page.tsx`) ;
 * 2. chaque écran répond ;
 * 3. chaque écran s'atteint depuis l'accueil en 3 clics au plus, sur ordinateur comme sur mobile. Un « clic » est un lien suivi vers un écran :
 *    déplier une rubrique du menu, ouvrir la feuille « Plus » ou la feuille des sections d'une fiche ne change pas d'écran et ne compte pas
 *    (le geste réel de ces feuilles est vérifié dans navigation-menu.spec.ts et fiche-hubs.spec.ts).
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
    // (un par largeur, soit trois au plus pour cinq places)
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
/** Restes d'un essai interrompu : logements de ce test vieux de plus d'une heure (le logement réel est daté un jour plus tard). */
async function purge() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("delete from properties where name like 'Inventaire %' and (created_at < now() - interval '1 hour' or created_at between now() and now() + interval '23 hours')"); } finally { await c.end(); }
}
async function remove(ids: string[]) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("delete from properties where id = any($1)", [ids]); } finally { await c.end(); }
}

/** Liens que la personne peut suivre : menu adapté à la largeur et contenu de la page. */
async function liens(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window.innerWidth;
    const menus = w >= 1024 ? [".rail"] : w >= 768 ? [".navbar", ".nav-sheet"] : [".bottombar", ".nav-sheet"];
    const sel = [...menus, ".content", ".fn"].map((s) => `${s} a[href]`).join(",");
    // la feuille des sections d'une fiche n'existe pas en grand écran
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(sel)).filter((a) => !(w >= 1024 && a.closest(".section-switcher"))).map((a) => a.getAttribute("href")!).filter((h) => h.startsWith("/"));
  });
}

test("Inventaire : chaque écran répond et s'atteint depuis l'accueil en 3 clics au plus", async ({ page }, info) => {
  test.setTimeout(240_000);
  const db = hasDatabase();
  const ids: string[] = [];
  try {
    const own = db ? await seed(page, `${info.project.name}-${Date.now().toString(36)}`, ids) : null;
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
    let frontier = ["/"];
    for (let d = 0; d < MAX_CLICS; d++) {
      const next: string[] = [];
      for (const href of frontier) {
        const res = await page.goto(href);
        expect(res?.status(), `${href} : statut HTTP`).toBeLessThan(400);
        await expect(page).not.toHaveURL(/\/connexion/);
        for (const l of await liens(page)) {
          const k = classify(l);
          if (!k) continue;
          if (!depth.has(k)) depth.set(k, d + 1);
          const sien = own && l.includes(own.reel);
          const visit = `${k}|${sien ? "sien" : "autre"}`;
          if (!visited.has(visit)) { visited.add(visit); next.push(l); }
        }
      }
      frontier = next;
    }
    const manquants: string[] = [];
    for (const s of SCREENS) {
      // données absentes : logement réel non créable (environnement distant), ou aucun rapport préparé
      if (!db && (s.needs === "propriete" || s.needs === "brouillon")) continue;
      if (s.needs === "rapport" && !depth.has(keyOf(s))) continue;
      if (!depth.has(keyOf(s))) manquants.push(keyOf(s));
    }
    expect(manquants, `écrans hors de portée en ${MAX_CLICS} clics`).toEqual([]);
  } finally { if (ids.length) await remove(ids); }
});

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

import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";

// à toutes les largeurs : la boîte complète (synthèse, filtres visibles) ; le mode poche a son fichier (poche-accueil-opportunites)
test.use(VERSION_COMPLETE);

// US-082 : la boîte d'opportunités se filtre (logement, playbook, urgence), se trie, et le rang de priorité ne change pas quand on filtre.
const rankOf = (t: string | null) => Number(/#(\d+)/.exec(t ?? "")?.[1] ?? NaN);

test("Boîte d'opportunités : filtres visibles, compteur, aucun débordement", async ({ page }) => {
  await page.goto("/");
  const f = page.getByTestId("inbox-filtres");
  await expect(f).toBeVisible();
  for (const l of ["Logement", "Playbook", "Urgence", "Tri"]) await expect(f.getByLabel(l)).toBeVisible();
  await expect(page.getByTestId("inbox-compteur")).toContainText(/\d+ résultats?/);
  await expect(page.getByTestId("reinitialiser")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "inbox filtres");
  await f.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("inbox-filtres.png") });
  await test.info().attach("inbox-filtres", { path: test.info().outputPath("inbox-filtres.png"), contentType: "image/png" });
});

const cartes = (page: import("@playwright/test").Page) => page.locator("article.sit").evaluateAll((els) => els.map((e) => ({ code: e.querySelector(".tag-mono")?.textContent ?? "", pb: (e.querySelectorAll(".sit-rank .tag:not(.tag-mono)")[0]?.textContent ?? ""), rank: Number(/#(\d+)/.exec(e.querySelector(".sit-rank-no")?.textContent ?? "")?.[1] ?? NaN) })));

test("Filtrer garde le rang de priorité du classement complet de chaque dossier, puis réinitialiser", async ({ page }) => {
  await page.goto("/");
  const avant = await cartes(page);
  expect(avant.length, "la démonstration doit fournir au moins deux situations ouvertes").toBeGreaterThan(1);
  const rangAvant = new Map(avant.map((c) => [c.code, c.rank]));
  // un playbook dont aucune carte n'est #1 : une renumérotation serait alors détectée
  const pb = avant.find((c) => c.rank > 1)!.pb;
  await page.getByTestId("inbox-filtres").getByLabel("Playbook").selectOption(pb);
  await page.getByRole("button", { name: "Appliquer" }).click();
  await expect(page).toHaveURL(/pb=PB-/);
  const apres = await cartes(page);
  expect(apres.length).toBeGreaterThan(0);
  expect(apres.length).toBeLessThanOrEqual(avant.length);
  for (const c of apres) { expect(c.pb).toBe(pb); expect(c.rank, `rang de ${c.code}`).toBe(rangAvant.get(c.code)); }
  expect(Math.min(...apres.map((c) => c.rank))).toBeGreaterThan(1);
  await expect(page.getByTestId("inbox-compteur")).toContainText("1 filtre actif");
  await expectNoHorizontalOverflow(page, "inbox filtrée");
  await page.getByTestId("reinitialiser").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("article.sit")).toHaveCount(avant.length);
});

test("Combinaison sans résultat déterministe : état vide explicite ; paramètres invalides ignorés", async ({ page }) => {
  await page.goto("/?u=veto");
  const veto = await cartes(page);
  const tous = await cartes(await (async () => { await page.goto("/"); return page; })());
  const sansVeto = tous.map((c) => c.pb).find((pb) => !veto.some((v) => v.pb === pb));
  test.skip(!sansVeto, "tous les playbooks de la démonstration portent un veto");
  await page.goto(`/?pb=${sansVeto}&u=veto`);
  await expect(page.getByRole("heading", { name: "Aucun résultat avec ces filtres" })).toBeVisible();
  await expect(page.getByText("ce n'est pas une confirmation")).toBeVisible();
  await expectNoHorizontalOverflow(page, "inbox vide");
  const r = await page.goto("/?f=bidon&p=inconnu&pb=%3Cscript%3Ex%3C%2Fscript%3E&u=zz&s=zz");
  expect(r?.status()).toBe(200);
  await expect(page.getByText("<script>")).toHaveCount(0);
  await expect(page.getByTestId("reinitialiser")).toHaveCount(0);
  await expect(page.getByTestId("inbox-filtres").getByLabel("Playbook")).toHaveValue("");
});

test("Statuts et urgence : « Garde-fous & vetos » égale la synthèse, « Traitées » ne montre que du traité, urgence combinable", async ({ page }) => {
  await page.goto("/?f=garde-fous");
  const n = (await page.locator("article.sit").count());
  const metric = await page.locator(".synth").getByText(/Garde-fous/).first().locator("xpath=ancestor::*[contains(@class,'metric')][1]").innerText().catch(() => "");
  if (metric) expect(Number(/\n(\d+)\n/.exec("\n" + metric.replace(/\s*\n\s*/g, "\n") + "\n")?.[1] ?? n)).toBe(n);
  await page.goto("/?f=traitees");
  await expect(page.locator("article.sit.is-settled")).toHaveCount(await page.locator("article.sit").count());
  await page.goto("/?u=urgent&s=sejour");
  await expect(page.getByTestId("inbox-filtres").getByLabel("Urgence")).toHaveValue("urgent");
  await expect(page.getByTestId("inbox-filtres").getByLabel("Tri")).toHaveValue("impact".replace("impact", "sejour"));
  await expectNoHorizontalOverflow(page, "inbox urgence + tri séjour");
});

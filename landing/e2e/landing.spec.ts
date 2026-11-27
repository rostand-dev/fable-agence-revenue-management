import { expect, test, type Page } from "@playwright/test";

const SLOGAN = "Une agence de revenue management, sans la prestation.";

/** Ouvre la landing en relevant les erreurs JavaScript et les ressources introuvables. */
async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto("/");
  return errors;
}

/** Fait défiler toute la page, pour déclencher les apparitions et le chargement différé des images. */
async function scrollAll(page: Page) {
  const h = await page.evaluate(() => document.body.scrollHeight);
  const step = (page.viewportSize()?.height ?? 800) * 0.7;
  for (let y = 0; y < h; y += step) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(120); }
}

test("la page s'affiche sans erreur, avec le slogan et sans défilement horizontal", async ({ page }) => {
  const errors = await open(page);
  await expect(page.getByRole("heading", { level: 1, name: SLOGAN })).toBeVisible();
  await expect(page.locator(".sl-accent")).toHaveText("sans la prestation.", { timeout: 6_000 });
  await scrollAll(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const broken = await page.evaluate(() => Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));
  expect(broken).toEqual([]);
  expect(errors).toEqual([]);
});

test("les appels à l'action mènent à l'application et à la démo", async ({ page }) => {
  await open(page);
  const app = await page.evaluate(() => (window as unknown as { NS_LINKS?: { app?: string } }).NS_LINKS?.app || "https://connect.nuitsignal.rosyops.io");
  for (const a of await page.locator('a[data-href="signup"]').all()) await expect(a).toHaveAttribute("href", `${app.replace(/\/+$/, "")}/inscription`);
  await expect(page.locator('a[data-href="demo"]').first()).toHaveAttribute("href", /^https:\/\//);
});

test("le thème suit l'appareil, et le bouton bascule vers l'inverse puis revient en automatique", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // le fond change avec une transition : on attend la couleur finale
  await expect.poll(bg).toBe("rgb(4, 5, 10)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(bg).toBe("rgb(245, 247, 252)");
  const btn = page.locator("#themeBtn");
  await btn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(bg).toBe("rgb(4, 5, 10)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await btn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "auto");
});

test("le slider présente les huit agents, au clic, au clavier et avec les flèches", async ({ page }) => {
  await open(page);
  const slider = page.locator("#slider");
  await slider.scrollIntoViewIfNeeded();
  await expect(page.locator(".slide")).toHaveCount(8);
  await expect(page.locator(".slide.is-active h3")).toContainText("Lina");
  await page.locator("#next").click();
  await expect(page.locator(".slide.is-active h3")).toContainText("Inès");
  await page.locator("#thumbs button").nth(6).click();
  await expect(page.locator(".slide.is-active h3")).toContainText("Victor");
  await expect(page.locator("#thumbs button").nth(6)).toHaveAttribute("aria-current", "true");
  await page.locator("#thumbs button").nth(6).press("ArrowRight");
  await expect(page.locator(".slide.is-active h3")).toContainText("Théo");
  await page.locator("#thumbs button").nth(7).press("Home");
  await expect(page.locator(".slide.is-active h3")).toContainText("Lina");
  await page.locator("#thumbs button").nth(0).press("End");
  await expect(page.locator(".slide.is-active h3")).toContainText("Théo");
  // la présentation complète finit par s'afficher, mot pour mot
  await expect(page.locator(".slide.is-active [data-say]")).toHaveText(/sans chiffre non certifié\.\s»$/, { timeout: 15_000 });
  // les diapositives masquées ne sont pas atteignables au clavier
  expect(await page.locator(".slide[aria-hidden='true']").count()).toBe(7);
});

test("le workflow met en avant l'étape choisie", async ({ page }) => {
  await open(page);
  await page.locator("#flow").scrollIntoViewIfNeeded();
  await page.locator("#flowSteps li").nth(5).locator("button").click();
  await expect(page.locator("#flowSteps li").nth(5)).toHaveClass(/active/);
  await expect(page.locator("#flowSteps li.done")).toHaveCount(5);
});

test("le bouton de pause arrête les animations automatiques et s'en souvient", async ({ page }) => {
  await open(page);
  const btn = page.locator("#motionBtn");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveClass(/motion-off/);
  // la console affiche toutes ses lignes, le slider présente son texte entier sans avancer seul
  await expect(page.locator("#console li").last()).toHaveCSS("opacity", "1");
  await page.locator("#slider").scrollIntoViewIfNeeded();
  await expect(page.locator(".slide.is-active [data-say]")).toHaveText(/je vous le dis aussi\.\s»$/);
  await page.waitForTimeout(5_000);
  await expect(page.locator(".slide.is-active h3")).toContainText("Lina");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/motion-off/);
  await page.locator("#motionBtn").click();
  await expect(page.locator("html")).not.toHaveClass(/motion-off/);
});

test("les onglets de l'aperçu changent les captures de l'ordinateur et du téléphone", async ({ page }) => {
  await open(page);
  await page.locator("#apercu").scrollIntoViewIfNeeded();
  await page.locator("#shotTabs button").nth(2).click();
  await expect(page.locator(".laptop img.is-on")).toHaveAttribute("src", /desktop-logement/);
  await expect(page.locator(".phone img.is-on")).toHaveAttribute("src", /mobile-accueil/);
  // seules les captures affichées sont exposées aux lecteurs d'écran ; flèches du clavier entre onglets
  await expect(page.locator(".laptop img[aria-hidden='false']")).toHaveCount(1);
  await page.locator("#shotTabs button").nth(2).press("ArrowRight");
  await expect(page.locator("#shotTabs button").nth(0)).toBeFocused();
  await expect(page.locator("#stage")).toHaveAttribute("aria-labelledby", "shotTab0");
});

test("en production (nginx) : santé, en-têtes de sécurité, adresses injectées et page 404", async ({ page, request }) => {
  const health = await request.get("/healthz");
  test.skip(health.status() !== 200, "servi sans nginx (serveur statique local) : test réservé à l'image Docker");
  const res = await request.get("/");
  expect(res.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  const cfg = await (await request.get("/assets/config.js")).text();
  expect(cfg).toContain(process.env.LANDING_EXPECTED_APP_URL || "window.NS_LINKS");
  const missing = await request.get("/page-inexistante");
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("Signal perdu");
  // aucune violation de CSP : la page complète tourne sans erreur console sous les vrais en-têtes
  const errors = await open(page);
  await scrollAll(page);
  expect(errors).toEqual([]);
});

test.describe("mouvement réduit", () => {
  test.use({ reducedMotion: "reduce" });
  test("tout le texte est lisible tout de suite, sans animation", async ({ page }) => {
    await open(page);
    await expect(page.locator(".sl-accent")).toHaveText("sans la prestation.");
    await expect(page.locator("#console li").last()).toHaveCSS("opacity", "1");
    await page.locator("#slider").scrollIntoViewIfNeeded();
    await expect(page.locator(".slide.is-active [data-say]")).toHaveText(/je vous le dis aussi\.\s»$/);
  });
});

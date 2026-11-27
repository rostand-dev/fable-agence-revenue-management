import { defineConfig, devices } from "@playwright/test";

/**
 * Tests de la landing (site statique, sans base ni compte). Lancement : `npm run e2e:landing` depuis la racine du dépôt.
 * - LANDING_BASE_URL : adresse à tester (ex. la landing déployée). Absente : la landing est servie ici par un petit serveur statique Python.
 * - E2E_CHROME_PATH : chemin d'un Chrome déjà installé (poste local). Absent : Chromium de Playwright.
 */
const external = process.env.LANDING_BASE_URL?.trim();
const executablePath = process.env.E2E_CHROME_PATH?.trim() || undefined;
const launchOptions = executablePath ? { executablePath } : {};
const PHONE_UA = devices["Pixel 7"].userAgent;

export default defineConfig({
  testDir: "e2e",
  outputDir: "../test-results/landing",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report/landing" }]] : [["list"]],
  use: { baseURL: external || "http://127.0.0.1:4173", locale: "fr-FR", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "bureau", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: "tablette", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, launchOptions } },
    { name: "mobile-390", use: { ...devices["Desktop Chrome"], userAgent: PHONE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, launchOptions } },
    { name: "mobile-360", use: { ...devices["Desktop Chrome"], userAgent: PHONE_UA, viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, launchOptions } },
  ],
  webServer: external ? undefined : {
    command: "python3 -m http.server 4173 --bind 127.0.0.1",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Tests de bout en bout (navigateur réel), bureau et mobile.
 * - E2E_BASE_URL : adresse à tester (ex. une Preview Coolify). Absente : l'application est lancée ici (`npm run start`, après `npm run build`).
 * - E2E_EMAIL / E2E_PASSWORD : compte de démo utilisé pour se connecter.
 * - E2E_CHROME_PATH : chemin d'un Chrome déjà installé (poste local sans téléchargement de navigateur). Absent : Chromium de Playwright.
 */
const external = process.env.E2E_BASE_URL?.trim();
const baseURL = external || "http://127.0.0.1:3000";
const executablePath = process.env.E2E_CHROME_PATH?.trim() || undefined;
const launchOptions = executablePath ? { executablePath } : {};

// Les largeurs mobiles couvrent les petits téléphones (360 px) et les courants (390 px).
const chromium = (name: string, viewport: { width: number; height: number }, mobile: boolean) => ({
  name,
  dependencies: ["setup"],
  testIgnore: /auth\.setup\.ts/,
  use: {
    ...devices["Desktop Chrome"],
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    storageState: "e2e/.auth/state.json",
    launchOptions,
  },
});

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", locale: "fr-FR" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    chromium("bureau", { width: 1280, height: 800 }, false),
    chromium("mobile-390", { width: 390, height: 844 }, true),
    chromium("mobile-360", { width: 360, height: 740 }, true),
  ],
  webServer: external
    ? undefined
    : { command: "npm run start", url: `${baseURL}/api/health`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});

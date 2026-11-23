import { defineConfig, devices } from "@playwright/test";
import { httpCredentials } from "./e2e/helpers/env";

/**
 * Tests de bout en bout (navigateur réel), bureau et mobile.
 * - E2E_BASE_URL : adresse à tester (ex. une Preview Coolify). Absente : l'application est lancée ici (`npm run start`, après `npm run build`).
 * - E2E_EMAIL / E2E_PASSWORD : compte de démo utilisé pour se connecter.
 * - E2E_HTTP_USER / E2E_HTTP_PASSWORD : identifiants HTTP Basic si l'environnement testé est protégé (Preview Coolify). Absents : aucune authentification HTTP.
 * - E2E_CHROME_PATH : chemin d'un Chrome déjà installé (poste local sans téléchargement de navigateur). Absent : Chromium de Playwright.
 * - ANTHROPIC_API_BASE : adresse du faux serveur de modèle (ex. http://127.0.0.1:4011). Si elle pointe vers cette machine, le faux serveur (scripts/fake-llm-server.ts)
 *   est lancé avant l'application, qui le lit comme elle lirait Anthropic (avec ANTHROPIC_API_KEY factice). Absente : les agents restent en repli déterministe.
 * - PRICELABS_API_BASE : adresse du faux serveur PriceLabs (ex. http://127.0.0.1:4010/v1). Si elle pointe vers cette machine, le faux serveur
 *   (scripts/fake-pricelabs-server.ts) est lancé avant l'application, qui le lit comme elle lirait PriceLabs. Absente : les tests PriceLabs sont ignorés.
 */
const external = process.env.E2E_BASE_URL?.trim();
const baseURL = external || "http://127.0.0.1:3000";
const executablePath = process.env.E2E_CHROME_PATH?.trim() || undefined;
const launchOptions = executablePath ? { executablePath } : {};
const fakePriceLabs = (() => { try { const u = new URL(process.env.PRICELABS_API_BASE ?? ""); return u.hostname === "127.0.0.1" ? u : null; } catch { return null; } })();

const fakeLlm = (() => { try { const u = new URL(process.env.ANTHROPIC_API_BASE ?? ""); return u.hostname === "127.0.0.1" || u.hostname === "localhost" ? u : null; } catch { return null; } })();

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
  use: { baseURL, httpCredentials,
  // Environnement distant : jamais de trace (elle contiendrait l'en-tête Authorization et le mot de passe saisi).
  trace: external ? "off" : "retain-on-failure", screenshot: "only-on-failure", locale: "fr-FR" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"], launchOptions } },
    chromium("bureau", { width: 1280, height: 800 }, false),
    chromium("mobile-390", { width: 390, height: 844 }, true),
    chromium("mobile-360", { width: 360, height: 740 }, true),
  ],
  webServer: external
    ? undefined
    : [
      // le faux serveur PriceLabs démarre avant l'application (qui le lit via PRICELABS_API_BASE)
      ...(fakePriceLabs ? [{ command: "npx tsx scripts/fake-pricelabs-server.ts", url: `${fakePriceLabs.origin}/__health`, env: { FAKE_PRICELABS_PORT: fakePriceLabs.port || "4010" }, reuseExistingServer: !process.env.CI, timeout: 60_000 }] : []),
      ...(fakeLlm ? [{ command: "npx tsx scripts/fake-llm-server.ts", url: `${fakeLlm.origin}/__health`, env: { FAKE_LLM_PORT: fakeLlm.port || "4011" }, reuseExistingServer: !process.env.CI, timeout: 60_000 }] : []),
      { command: "npm run start", url: `${baseURL}/api/health`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
    ],
});

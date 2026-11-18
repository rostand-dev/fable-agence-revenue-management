import { describe, expect, it } from "vitest";
import { demoAccountDecision, hostMatches, hostOf } from "./demo-account-config";

const OK = {
  DEMO_ACCOUNT_ENABLED: "true",
  DEMO_ACCOUNT_ALLOWED_HOST: "*.nuit-signal.rosyops.io",
  DEMO_ACCOUNT_EMAIL: "Demo@Exemple.fr",
  DEMO_ACCOUNT_PASSWORD: "un-mot-de-passe-solide",
  APP_URL: "https://pr-12.nuit-signal.rosyops.io",
};

describe("domaine autorisé", () => {
  it("extrait le nom d'hôte de APP_URL", () => {
    expect(hostOf("https://PR-12.nuit-signal.rosyops.io:8443/x")).toBe("pr-12.nuit-signal.rosyops.io");
    expect(hostOf("")).toBe("");
    expect(hostOf(undefined)).toBe("");
    expect(hostOf("pas une url")).toBe("");
  });
  it("accepte un sous-domaine avec le joker de tête", () => {
    expect(hostMatches("pr-12.nuit-signal.rosyops.io", "*.nuit-signal.rosyops.io")).toBe(true);
    expect(hostMatches("a.b.nuit-signal.rosyops.io", "*.nuit-signal.rosyops.io")).toBe(true);
  });
  it("refuse la production, qui n'a pas de sous-domaine devant", () => {
    expect(hostMatches("nuit-signal.rosyops.io", "*.nuit-signal.rosyops.io")).toBe(false);
  });
  it("refuse un domaine qui ne fait que finir pareil", () => {
    expect(hostMatches("evilnuit-signal.rosyops.io", "*.nuit-signal.rosyops.io")).toBe(false);
    expect(hostMatches("pr-12.nuit-signal.rosyops.io.evil.fr", "*.nuit-signal.rosyops.io")).toBe(false);
  });
  it("accepte un domaine exact", () => {
    expect(hostMatches("preview.exemple.fr", "Preview.Exemple.fr")).toBe(true);
    expect(hostMatches("autre.exemple.fr", "preview.exemple.fr")).toBe(false);
  });
  it("ne correspond jamais pour vide, « disabled » ou joker mal placé", () => {
    for (const p of [undefined, "", " ", "disabled", "*", "*.", "*.fr*", "pr-*.exemple.fr", "**.exemple.fr"]) expect(hostMatches("pr-1.exemple.fr", p)).toBe(false);
    expect(hostMatches("", "*.exemple.fr")).toBe(false);
  });
});

describe("décision de créer le compte de démo", () => {
  it("crée quand tout est réuni, e-mail en minuscules et nom par défaut", () => {
    expect(demoAccountDecision(OK)).toEqual({ run: true, email: "demo@exemple.fr", password: "un-mot-de-passe-solide", name: "Compte démo" });
    expect(demoAccountDecision({ ...OK, DEMO_ACCOUNT_NAME: " Rosy " })).toMatchObject({ run: true, name: "Rosy" });
  });
  it("reste désactivé par défaut, sans bruit", () => {
    for (const v of [undefined, "", "false", "0", "disabled", "non"]) expect(demoAccountDecision({ ...OK, DEMO_ACCOUNT_ENABLED: v })).toEqual({ run: false, reason: null });
    expect(demoAccountDecision({})).toEqual({ run: false, reason: null });
  });
  it("ne lit rien d'autre quand le drapeau est faux (cas de la production)", () => {
    expect(demoAccountDecision({ DEMO_ACCOUNT_ENABLED: "false", DEMO_ACCOUNT_ALLOWED_HOST: "disabled" })).toEqual({ run: false, reason: null });
  });
  it("refuse sur la production même avec le drapeau posé", () => {
    const d = demoAccountDecision({ ...OK, APP_URL: "https://nuit-signal.rosyops.io" });
    expect(d.run).toBe(false);
    expect((d as any).reason).toMatch(/non autorisé/);
  });
  it("refuse si le domaine autorisé est absent ou « disabled »", () => {
    for (const v of [undefined, "", "disabled"]) expect(demoAccountDecision({ ...OK, DEMO_ACCOUNT_ALLOWED_HOST: v }).run).toBe(false);
  });
  it("refuse un mot de passe trop court ou égal à l'e-mail", () => {
    expect((demoAccountDecision({ ...OK, DEMO_ACCOUNT_PASSWORD: "court" }) as any).reason).toMatch(/au moins 10/);
    expect(demoAccountDecision({ ...OK, DEMO_ACCOUNT_PASSWORD: "demo@exemple.fr" }).run).toBe(false);
    expect(demoAccountDecision({ ...OK, DEMO_ACCOUNT_PASSWORD: undefined }).run).toBe(false);
  });
  it("refuse un e-mail absent ou invalide", () => {
    for (const v of [undefined, "", "pas-un-mail", "a@b"]) expect(demoAccountDecision({ ...OK, DEMO_ACCOUNT_EMAIL: v }).run).toBe(false);
  });
});

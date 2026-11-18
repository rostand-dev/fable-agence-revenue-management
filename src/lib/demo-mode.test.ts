import { describe, expect, it } from "vitest";
import { blockedInReadonly, demoReadonly, demoSignupUrl, demoUrl, httpUrl } from "./demo-mode";

describe("lecture seule", () => {
  it("est désactivée par défaut", () => {
    for (const v of [undefined, "", "false", "0", "non", "disabled"]) expect(demoReadonly(v)).toBe(false);
    for (const v of ["true", " TRUE ", "1", "on", "oui"]) expect(demoReadonly(v)).toBe(true);
  });
  it("laisse passer les lectures", () => {
    for (const m of ["GET", "get", "HEAD", "OPTIONS"]) expect(blockedInReadonly(m, "/logements")).toBe(false);
  });
  it("refuse tout ce qui modifie, actions serveur comprises (POST sur la page)", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) for (const p of ["/", "/logements/nouveau", "/connexion", "/api/chat", "/reglages"]) expect(blockedInReadonly(m, p)).toBe(true);
  });
  it("n'autorise que le suivi d'activité et la fin de session", () => {
    expect(blockedInReadonly("POST", "/api/session/touch")).toBe(false);
    expect(blockedInReadonly("POST", "/api/session/end/")).toBe(false);
    expect(blockedInReadonly("POST", "/api/session/touch/../chat")).toBe(true);
    expect(blockedInReadonly("POST", "/api/session")).toBe(true);
  });
});

describe("adresses de la démo", () => {
  it("n'accepte que du http(s) valide", () => {
    expect(httpUrl("https://demo.exemple.fr")).toBe("https://demo.exemple.fr/");
    for (const v of [undefined, "", "demo.exemple.fr", "javascript:alert(1)", "ftp://x.fr", "pas une url"]) expect(httpUrl(v)).toBeNull();
  });
  it("disparaît quand la variable est absente ou vide", () => {
    expect(demoUrl(undefined)).toBeNull();
    expect(demoUrl("")).toBeNull();
    expect(demoSignupUrl("https://nuit-signal.rosyops.io/inscription")).toBe("https://nuit-signal.rosyops.io/inscription");
  });
});

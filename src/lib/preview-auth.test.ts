import { describe, expect, it } from "vitest";
import { basicAuthOk, previewAuthConfig, previewAuthDecision, safeEqual } from "./preview-auth";

const PW = "un-mot-de-passe-solide";
const ENV = { PREVIEW_BASIC_AUTH_USER: "preview", PREVIEW_BASIC_AUTH_PASSWORD: PW };
const basic = (u: string, p: string) => "Basic " + btoa(`${u}:${p}`);

describe("protection de la Preview", () => {
  it("sans variable, rien n'est protégé (production, démo, staging)", () => {
    expect(previewAuthConfig({}).state).toBe("off");
    expect(previewAuthDecision("/", null, {})).toBe("allow");
    expect(previewAuthDecision("/dossier/x", undefined, { PREVIEW_BASIC_AUTH_USER: "", PREVIEW_BASIC_AUTH_PASSWORD: "" })).toBe("allow");
  });
  it("configuration incomplète ou faible : accès refusé, jamais ouvert par erreur", () => {
    expect(previewAuthConfig({ PREVIEW_BASIC_AUTH_USER: "preview" }).state).toBe("invalid");
    expect(previewAuthConfig({ PREVIEW_BASIC_AUTH_PASSWORD: PW }).state).toBe("invalid");
    expect(previewAuthConfig({ ...ENV, PREVIEW_BASIC_AUTH_PASSWORD: "court" }).state).toBe("invalid");
    expect(previewAuthConfig({ ...ENV, PREVIEW_BASIC_AUTH_USER: "a:b" }).state).toBe("invalid");
    expect(previewAuthDecision("/", basic("preview", PW), { PREVIEW_BASIC_AUTH_USER: "preview" })).toBe("misconfigured");
  });
  it("identifiants corrects : accès ; sinon : demande d'identifiants", () => {
    expect(previewAuthDecision("/", basic("preview", PW), ENV)).toBe("allow");
    expect(previewAuthDecision("/", null, ENV)).toBe("challenge");
    expect(previewAuthDecision("/", basic("preview", "mauvais-mot-de-passe"), ENV)).toBe("challenge");
    expect(previewAuthDecision("/", basic("autre", PW), ENV)).toBe("challenge");
    expect(previewAuthDecision("/", "basic " + btoa(`preview:${PW}`), ENV)).toBe("allow"); // le schéma est insensible à la casse (RFC 7617)
    expect(previewAuthDecision("/", "Bearer abc", ENV)).toBe("challenge");
    expect(previewAuthDecision("/", "Basic !!!pas-du-base64", ENV)).toBe("challenge");
    expect(previewAuthDecision("/", "Basic " + btoa("sans-deux-points"), ENV)).toBe("challenge");
  });
  it("un mot de passe contenant « : » ou des accents fonctionne", () => {
    const env = { PREVIEW_BASIC_AUTH_USER: "preview", PREVIEW_BASIC_AUTH_PASSWORD: "mot:de:passe-é-solide" };
    const enc = "Basic " + btoa(String.fromCharCode(...new TextEncoder().encode("preview:mot:de:passe-é-solide")));
    expect(previewAuthDecision("/", enc, env)).toBe("allow");
  });
  it("seul le contrôle de santé reste ouvert", () => {
    expect(previewAuthDecision("/api/health", null, ENV)).toBe("allow");
    expect(previewAuthDecision("/api/health/", null, ENV)).toBe("allow");
    expect(previewAuthDecision("/api/health/x", null, ENV)).toBe("challenge");
    expect(previewAuthDecision("/api/session/touch", null, ENV)).toBe("challenge");
    expect(previewAuthDecision("/demo", null, ENV)).toBe("challenge");
  });
  it("comparaison sans fuite de longueur évidente", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(basicAuthOk(basic("preview", PW), { state: "on", user: "preview", password: PW })).toBe(true);
  });
});

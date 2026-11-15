import { describe, expect, it } from "vitest";
import { clientIp, generateToken, hashToken, isPwned, looksLikeToken, passwordProblem, rateKey, resetLink, resetMinutesFromEnv } from "./password-reset";
import { resetPasswordEmail } from "./email/templates/reset-password";
import { passwordChangedEmail } from "./email/templates/password-changed";

describe("jeton de réinitialisation", () => {
  it("fait 43 caractères base64url et se hache en SHA-256", () => {
    const { token, hash } = generateToken();
    expect(looksLikeToken(token)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });
  it("ne génère jamais deux fois le même jeton", () => {
    expect(new Set(Array.from({ length: 200 }, () => generateToken().token)).size).toBe(200);
  });
  it("écarte les valeurs qui ne peuvent pas être un jeton", () => {
    for (const t of ["", "abc", "x".repeat(42), "x".repeat(44), "../".repeat(15), "a b".padEnd(43, "a"), "é".repeat(43)]) expect(looksLikeToken(t)).toBe(false);
  });
});

describe("durée de validité (PASSWORD_RESET_MINUTES)", () => {
  it("vaut 30 min par défaut et retombe dessus si invalide", () => {
    for (const v of [undefined, "", "abc", "0", "4", "121", "-3", "NaN"]) expect(resetMinutesFromEnv(v)).toBe(30);
  });
  it("accepte une valeur entre 5 et 120", () => { expect(resetMinutesFromEnv("5")).toBe(5); expect(resetMinutesFromEnv(" 60 ")).toBe(60); expect(resetMinutesFromEnv("120")).toBe(120); });
});

describe("lien", () => {
  it("est construit avec APP_URL, sans double barre", () => {
    expect(resetLink("TOK", "https://rm.exemple.fr/")).toBe("https://rm.exemple.fr/reinitialisation/TOK");
    expect(resetLink("TOK", undefined)).toBe("http://localhost:3000/reinitialisation/TOK");
  });
});

describe("règles du mot de passe", () => {
  it("refuse trop court, trop long et identique à l'e-mail", () => {
    expect(passwordProblem("court")).toMatch(/au moins 10/);
    expect(passwordProblem("x".repeat(129))).toMatch(/128/);
    expect(passwordProblem("Rosy@Exemple.fr", "rosy@exemple.fr")).toMatch(/e-mail/);
  });
  it("accepte un mot de passe correct", () => { expect(passwordProblem("une phrase de passe solide", "a@b.fr")).toBeNull(); });
});

describe("limitation de débit", () => {
  it("produit des empreintes stables, sans la valeur en clair", () => {
    const a = rateKey("email", "Rosy@Exemple.fr");
    expect(a).toBe(rateKey("email", " rosy@exemple.fr "));
    expect(a).not.toBe(rateKey("ip", "rosy@exemple.fr"));
    expect(a).not.toContain("rosy");
  });
  it("lit l'IP du dernier saut de confiance", () => {
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null });
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientIp(h({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(h({}))).toBe("inconnue");
  });
});

describe("mot de passe compromis (k-anonymité)", () => {
  // SHA-1 de « password » = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  it("n'envoie que les 5 premiers caractères et détecte une correspondance", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return new Response("0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n"); }) as unknown as typeof fetch;
    expect(await isPwned("password", f)).toBe(true);
    expect(url).toBe("https://api.pwnedpasswords.com/range/5BAA6");
  });
  it("accepte un mot de passe absent de la liste", async () => {
    const f = (async () => new Response("0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n")) as unknown as typeof fetch;
    expect(await isPwned("password", f)).toBe(false);
  });
  it("laisse passer si le service est indisponible", async () => {
    expect(await isPwned("password", (async () => { throw new Error("réseau"); }) as unknown as typeof fetch)).toBe(false);
    expect(await isPwned("password", (async () => new Response("", { status: 503 })) as unknown as typeof fetch)).toBe(false);
  });
});

describe("e-mails", () => {
  const link = "https://rm.exemple.fr/reinitialisation/ABC_def-123";
  it("contiennent le lien, la durée et une version texte", () => {
    const m = resetPasswordEmail({ link, minutes: 30, appUrl: "https://rm.exemple.fr", name: "Rosy" });
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain("30 minutes");
    expect(m.text).toContain(link);
    expect(m.subject).toMatch(/mot de passe/i);
  });
  it("sont mobile d'abord et aux couleurs du design system", () => {
    const { html } = resetPasswordEmail({ link, minutes: 30, appUrl: "https://rm.exemple.fr" });
    expect(html).toContain('name="viewport"');
    expect(html).toContain("max-width:480px");
    expect(html).toContain("max-width:560px");
    expect(html).toContain("min-height:48px");
    for (const c of ["#04050a", "#0b0e1a", "#2563eb", "#7c3aed", "#eef1f8"]) expect(html).toContain(c);
    expect(html).toContain("https://rm.exemple.fr/brand/nuitsignal-email.png");
    expect(html).toContain('alt="NuitSignal"');
  });
  it("échappent le HTML du nom", () => {
    const m = resetPasswordEmail({ link, minutes: 30, appUrl: "https://rm.exemple.fr", name: '<img src=x onerror="alert(1)">' });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img");
    const c = passwordChangedEmail({ appUrl: "https://rm.exemple.fr", when: "15 novembre 2026", name: "<b>x</b>" });
    expect(c.html).not.toContain("<b>x</b>");
    expect(c.html).toContain("15 novembre 2026");
  });
});

import { describe, expect, it } from "vitest";
import { REUSE_GRACE_MS, judgeToken, rememberDaysFromEnv, safeNext } from "./remember-policy";

describe("REMEMBER_ME_DAYS", () => {
  it("vaut 30 par défaut", () => { expect(rememberDaysFromEnv(undefined)).toBe(30); expect(rememberDaysFromEnv("")).toBe(30); });
  it("0 désactive la fonction", () => { expect(rememberDaysFromEnv("0")).toBe(0); });
  it("accepte un entier de 1 à 90", () => { expect(rememberDaysFromEnv("1")).toBe(1); expect(rememberDaysFromEnv(" 45 ")).toBe(45); expect(rememberDaysFromEnv("90")).toBe(90); });
  it("retombe sur 30 si invalide", () => { for (const v of ["abc", "-1", "91", "1.5", "NaN", "Infinity"]) expect(rememberDaysFromEnv(v)).toBe(30); });
});

describe("jugement d'un jeton", () => {
  const T = 1_700_000_000_000, future = new Date(T + 86_400_000);
  it("échu", () => { expect(judgeToken({ expiresAt: new Date(T), usedAt: null }, T)).toBe("expired"); expect(judgeToken({ expiresAt: new Date(T - 1), usedAt: new Date(T - 5) }, T)).toBe("expired"); });
  it("jamais utilisé : rotation", () => { expect(judgeToken({ expiresAt: future, usedAt: null }, T)).toBe("rotate"); });
  it("utilisé à l'instant : requête simultanée tolérée", () => {
    expect(judgeToken({ expiresAt: future, usedAt: new Date(T - 1000) }, T)).toBe("grace");
    expect(judgeToken({ expiresAt: future, usedAt: new Date(T - REUSE_GRACE_MS) }, T)).toBe("grace");
  });
  it("utilisé plus tôt : rejeu, la famille est révoquée", () => { expect(judgeToken({ expiresAt: future, usedAt: new Date(T - REUSE_GRACE_MS - 1) }, T)).toBe("reuse"); });
});

describe("destination après restauration", () => {
  it("accepte les chemins internes", () => { expect(safeNext("/logements/abc?tab=pricelabs")).toBe("/logements/abc?tab=pricelabs"); expect(safeNext("/")).toBe("/"); });
  it("refuse tout ce qui sort du site", () => {
    for (const v of ["https://evil.example", "//evil.example", "/\\evil.example", "evil", "javascript:alert(1)", "/a\nb", "/\u0000"]) expect(safeNext(v)).toBe("/");
  });
  it("refuse les routes techniques (boucle) et les valeurs vides ou trop longues", () => {
    expect(safeNext("/api/session/restore")).toBe("/");
    expect(safeNext(null)).toBe("/"); expect(safeNext(undefined)).toBe("/"); expect(safeNext("")).toBe("/");
    expect(safeNext("/" + "a".repeat(600))).toBe("/");
  });
});

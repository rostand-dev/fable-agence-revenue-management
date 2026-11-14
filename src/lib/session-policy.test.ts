import { describe, expect, it } from "vitest";
import { REFRESH_STEP_MS, idleMinutesFromEnv, isExpired, newExpiry, refreshedExpiry } from "./session-policy";

const T = 1_700_000_000_000;
const IDLE = 15 * 60_000;
describe("durée d'inactivité (SESSION_IDLE_MINUTES)", () => {
  it("vaut 15 min par défaut", () => { expect(idleMinutesFromEnv(undefined)).toBe(15); expect(idleMinutesFromEnv("")).toBe(15); });
  it("accepte une valeur valide", () => { expect(idleMinutesFromEnv("30")).toBe(30); expect(idleMinutesFromEnv(" 5 ")).toBe(5); expect(idleMinutesFromEnv("2.5")).toBe(2.5); });
  it("retombe sur 15 si invalide ou trop courte", () => {
    for (const v of ["abc", "0", "-5", "1", "NaN", "Infinity"]) expect(idleMinutesFromEnv(v)).toBe(15);
  });
});
describe("expiration de session", () => {
  it("expire après le délai donné", () => { expect(newExpiry(IDLE, T).getTime()).toBe(T + IDLE); expect(newExpiry(5 * 60_000, T).getTime()).toBe(T + 300_000); });
  it("est expirée à l'échéance exacte et après", () => {
    const e = new Date(T + IDLE);
    expect(isExpired(e, T + IDLE - 1)).toBe(false);
    expect(isExpired(e, T + IDLE)).toBe(true);
  });
  it("ne réécrit pas tout de suite après une prolongation", () => {
    expect(refreshedExpiry(newExpiry(IDLE, T), IDLE, T + REFRESH_STEP_MS - 1)).toBeNull();
  });
  it("repousse l'échéance du délai une fois le palier passé", () => {
    expect(refreshedExpiry(newExpiry(IDLE, T), IDLE, T + REFRESH_STEP_MS)?.getTime()).toBe(T + REFRESH_STEP_MS + IDLE);
  });
  it("ne ressuscite jamais une session échue", () => {
    expect(refreshedExpiry(newExpiry(IDLE, T), IDLE, T + IDLE + 1)).toBeNull();
  });
});

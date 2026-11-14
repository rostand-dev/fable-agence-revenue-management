import { describe, expect, it } from "vitest";
import { IDLE_MS, REFRESH_STEP_MS, isExpired, newExpiry, refreshedExpiry } from "./session-policy";

const T = 1_700_000_000_000;
describe("expiration de session", () => {
  it("expire 15 minutes après la création", () => {
    expect(IDLE_MS).toBe(15 * 60_000);
    expect(newExpiry(T).getTime()).toBe(T + IDLE_MS);
  });
  it("est expirée à l'échéance exacte et après", () => {
    const e = new Date(T + IDLE_MS);
    expect(isExpired(e, T + IDLE_MS - 1)).toBe(false);
    expect(isExpired(e, T + IDLE_MS)).toBe(true);
  });
  it("ne réécrit pas tout de suite après une prolongation", () => {
    expect(refreshedExpiry(newExpiry(T), T + REFRESH_STEP_MS - 1)).toBeNull();
  });
  it("repousse l'échéance de 15 min une fois le palier passé", () => {
    const next = refreshedExpiry(newExpiry(T), T + REFRESH_STEP_MS);
    expect(next?.getTime()).toBe(T + REFRESH_STEP_MS + IDLE_MS);
  });
  it("ne ressuscite jamais une session échue", () => {
    expect(refreshedExpiry(newExpiry(T), T + IDLE_MS + 1)).toBeNull();
  });
});

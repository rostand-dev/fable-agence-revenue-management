import { describe, expect, it } from "vitest";
import { capAlert } from "./cap-message";
import { capState } from "./cap-state";

const a = (capEur: number | null, spentUsd: number) => capAlert(capState(capEur, spentUsd, 1));

describe("alerte du plafond mensuel", () => {
  it("rien sans plafond, ni en dessous de 80 %", () => { expect(a(null, 500)).toBeNull(); expect(a(100, 79.99)).toBeNull(); });
  it("de 80 % à 100 % : alerte avec le pourcentage", () => {
    expect(a(100, 80)).toMatchObject({ level: "alert", title: expect.stringContaining("80 %") });
    expect(a(100, 99.9)?.level).toBe("alert");
  });
  it("à 100 % et au-delà : plafond atteint, mode déterministe annoncé", () => {
    for (const spent of [100, 140]) expect(a(100, spent)).toMatchObject({ level: "reached", title: expect.stringContaining("atteint"), body: expect.stringContaining("déterministe") });
  });
});

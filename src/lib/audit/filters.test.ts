import { describe, expect, it } from "vitest";
import { isActorKind, parseDay } from "./query";

describe("paramètres de filtre du journal", () => {
  it("parseDay n'accepte que de vrais jours civils", () => {
    expect(parseDay("2026-03-10")).toBe("2026-03-10");
    for (const bad of ["2026-02-31", "2026-13-01", "10/03/2026", "2026-3-1", "", "2026-03-10T00:00:00Z", undefined, null, 20260310]) expect(parseDay(bad)).toBeUndefined();
    expect(parseDay("2028-02-29")).toBe("2028-02-29");
    expect(parseDay("2026-02-29")).toBeUndefined();
  });
  it("isActorKind", () => { expect(isActorKind("human")).toBe(true); expect(isActorKind("root")).toBe(false); expect(isActorKind("toString")).toBe(false); });
});

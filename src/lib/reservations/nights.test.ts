import { describe, expect, it } from "vitest";
import { affectedWindow, allocate, diffReservation, MAX_NIGHTS, nightsOf, type Snap } from "./nights";

const snap = (o: Partial<Snap> = {}): Snap => ({ status: "CONFIRMED", channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-04", grossRoomCents: 30000, cleaningCents: 5000, commissionCents: 4500, paymentFeeCents: null, ...o });

describe("allocate", () => {
  it("la somme égale toujours le total, le reste va aux premières nuits", () => {
    expect(allocate(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(allocate(10001, 3)).toEqual([3334, 3334, 3333]);
    for (const [t, n] of [[0, 4], [1, 7], [99999, 13], [12345, 1]] as const) expect(allocate(t, n).reduce((a, b) => a + b, 0)).toBe(t);
  });
  it("montant négatif : la somme reste exacte", () => { expect(allocate(-10001, 3).reduce((a, b) => a + b, 0)).toBe(-10001); });
  it("aucune nuit si n ≤ 0", () => { expect(allocate(100, 0)).toEqual([]); expect(allocate(100, -2)).toEqual([]); });
});

describe("nightsOf", () => {
  it("une ligne par nuit, départ exclu, canal et statut repris", () => {
    const n = nightsOf(snap());
    expect(n.map((x) => x.night)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    expect(n.reduce((a, x) => a + x.grossRoomCents, 0)).toBe(30000);
    expect(n.reduce((a, x) => a + (x.commissionCents ?? 0), 0)).toBe(4500);
    expect(n.every((x) => x.paymentFeeCents === null && x.channel === "AIRBNB" && x.status === "CONFIRMED")).toBe(true);
  });
  it("aucune nuit pour une annulation, un doublon, des dates inversées ou aberrantes", () => {
    expect(nightsOf(snap({ status: "CANCELLED" }))).toEqual([]);
    expect(nightsOf(snap({ status: "DUPLICATE" }))).toEqual([]);
    expect(nightsOf(snap({ checkOut: "2026-12-01" }))).toEqual([]);
    expect(nightsOf(snap({ checkOut: "2026-11-20" }))).toEqual([]);
    expect(nightsOf(snap({ checkIn: "2026-01-01", checkOut: "2027-03-01" }))).toHaveLength(0);
    expect(MAX_NIGHTS).toBe(400);
  });
  it("bornes : 400 nuits acceptées, 401 refusées ; commission absente = null", () => {
    expect(nightsOf(snap({ checkIn: "2026-01-01", checkOut: "2027-02-05", commissionCents: null }))).toHaveLength(400);
    expect(nightsOf(snap({ checkIn: "2026-01-01", checkOut: "2027-02-06" }))).toHaveLength(0);
    expect(nightsOf(snap({ commissionCents: null })).every((x) => x.commissionCents === null)).toBe(true);
  });
  it("un blocage garde son statut", () => { expect(nightsOf(snap({ status: "BLOCKED" })).every((x) => x.status === "BLOCKED")).toBe(true); });
  it("traverse un changement de mois et d'année", () => {
    expect(nightsOf(snap({ checkIn: "2026-12-30", checkOut: "2027-01-02" })).map((x) => x.night)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });
});

describe("diffReservation", () => {
  it("inconnue = création", () => expect(diffReservation(null, snap()).kind).toBe("CREATED"));
  it("identique = inchangée", () => expect(diffReservation(snap(), snap())).toEqual({ kind: "UNCHANGED", changes: [] }));
  it("décrit les champs modifiés avec libellés français", () => {
    const d = diffReservation(snap(), snap({ checkOut: "2026-12-05", grossRoomCents: 40000 }));
    expect(d.kind).toBe("MODIFIED");
    expect(d.changes).toEqual([{ key: "checkOut", label: "Départ", from: "2026-12-04", to: "2026-12-05" }, { key: "grossRoomCents", label: "Hébergement", from: "300,00 €", to: "400,00 €" }]);
  });
  it("annulation puis réactivation", () => {
    expect(diffReservation(snap(), snap({ status: "CANCELLED" })).kind).toBe("CANCELLED");
    expect(diffReservation(snap({ status: "CANCELLED" }), snap()).kind).toBe("REACTIVATED");
    expect(diffReservation(snap({ status: "CANCELLED" }), snap({ status: "CANCELLED", grossRoomCents: 1 })).kind).toBe("MODIFIED");
  });
});

describe("affectedWindow", () => {
  it("couvre l'ancien et le nouveau séjour", () => {
    expect(affectedWindow({ checkIn: "2026-12-01", checkOut: "2026-12-04" }, { checkIn: "2026-12-10", checkOut: "2026-12-12" })).toEqual({ from: "2026-12-01", to: "2026-12-12" });
    expect(affectedWindow(null, { checkIn: "2026-12-10", checkOut: "2026-12-12" })).toEqual({ from: "2026-12-10", to: "2026-12-12" });
  });
});

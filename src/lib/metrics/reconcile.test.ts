import { describe, expect, it } from "vitest";
import { parseReconciliation, reconciliationState } from "../activation-gates";
import { floorGrossNightlyCents, emptyEconomics } from "../engine/economics";
import { seasonalFloorGrid } from "../engine/seasons";
import { simulate } from "../engine/simulator";
import type { EconomicModel } from "../engine/types";
import { nightsOf, type Snap } from "../reservations/nights";
import { REFERENCE_EXPECTED as X, REFERENCE_SAMPLE, type RefResa } from "@/test/reference-sample";
import { computeKpi, kpiByMonth, nightFactsFromResas } from "./kpi";
import { appNetCents, reconcile, toAttestation, type SampleRow } from "./reconcile";

const toSnap = (r: RefResa): Snap => ({ status: "CONFIRMED", channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, grossRoomCents: r.grossRoomCents, cleaningCents: null, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents });
const rows = (): SampleRow[] => REFERENCE_SAMPLE.map((r) => ({ id: r.id, channel: r.channel, app: r, sourceNetRoomCents: r.sourceNetRoomCents }));
const facts = () => REFERENCE_SAMPLE.flatMap((r) => nightsOf(toSnap(r)));

describe("échantillon de référence (US-054) : KPI contre valeurs calculées à la main", () => {
  it("les 12 réservations donnent exactement 41 nuits, 410 000 d'hébergement et 343 190 de net", () => {
    const k = computeKpi(X.period, facts());
    expect(k).toMatchObject({ soldNights: X.soldNights, grossRoomCents: X.grossRoomCents, netRoomCents: X.netRoomCents, netStatus: "COMPLETE", days: X.days, availableNights: X.days });
    expect(k.adrCents).toBe(X.adrCents); expect(k.netAdrCents).toBe(X.netAdrCents);
    expect(k.grossRevpanCents).toBe(X.grossRevpanCents); expect(k.netRevpanCents).toBe(X.netRevpanCents);
    expect(k.occupancy).toBeCloseTo(41 / 61, 12);
  });
  it("chaque KPI est à ±1 % du calcul à la main (tolérance du blueprint)", () => {
    const k = computeKpi(X.period, facts());
    const within = (got: number | null, want: number) => expect(Math.abs(got! - want) / want).toBeLessThanOrEqual(0.01);
    within(k.adrCents, X.adrCents); within(k.netAdrCents, X.netAdrCents); within(k.grossRevpanCents, X.grossRevpanCents); within(k.netRevpanCents, X.netRevpanCents);
    within(k.netRoomCents, X.netRoomCents);
  });
  it("octobre seul et répartition par canal", () => {
    const k = computeKpi(X.october, facts());
    expect(k).toMatchObject({ soldNights: X.octoberSoldNights, grossRoomCents: X.octoberGross, netRoomCents: X.octoberNet, adrCents: X.octoberAdr, netAdrCents: X.octoberNetAdr });
    const all = computeKpi(X.period, facts());
    expect(all.byChannel.find((c) => c.channel === "AIRBNB")).toMatchObject({ soldNights: X.airbnbNights, grossRoomCents: X.airbnbGross });
    expect(all.byChannel.find((c) => c.channel === "BOOKING")).toMatchObject({ soldNights: X.bookingNights, grossRoomCents: X.bookingGross });
  });
  it("invariants : somme des mois = période, somme des nuits = montant de chaque réservation, résultat indépendant de l'ordre", () => {
    const f = facts();
    const [sep, oct] = kpiByMonth(["2026-09", "2026-10"], f);
    const all = computeKpi(X.period, f);
    expect(sep.grossRoomCents + oct.grossRoomCents).toBe(all.grossRoomCents);
    expect(sep.netRoomCents! + oct.netRoomCents!).toBe(all.netRoomCents);
    expect(sep.soldNights + oct.soldNights).toBe(all.soldNights);
    for (const r of REFERENCE_SAMPLE) {
      const n = nightsOf(toSnap(r));
      expect(n).toHaveLength(r.nights);
      expect(n.reduce((a, x) => a + x.grossRoomCents, 0)).toBe(r.grossRoomCents);
      expect(n.reduce((a, x) => a + x.commissionCents!, 0)).toBe(r.commissionCents);
    }
    expect(computeKpi(X.period, [...f].reverse())).toEqual(all);
    const nf = nightFactsFromResas(REFERENCE_SAMPLE.map((r) => ({ status: "CONFIRMED", ...r })));
    expect(computeKpi(X.period, nf.sold, nf.blocked)).toEqual(all);
  });
});

describe("séjour à cheval sur deux mois et reliquat de centimes (calculé à la main)", () => {
  // 30/09 → 03/10, 3 nuits, 10 001 c : 3 334 + 3 334 + 3 333 ; commission 1 501 c : 501 + 500 + 500
  const snap: Snap = { status: "CONFIRMED", channel: "AIRBNB", checkIn: "2026-09-30", checkOut: "2026-10-03", grossRoomCents: 10001, cleaningCents: null, commissionCents: 1501, paymentFeeCents: null };
  it("le reliquat va aux premières nuits et la somme est exacte ; septembre et octobre se répartissent sans perte", () => {
    const n = nightsOf(snap);
    expect(n.map((x) => [x.night, x.grossRoomCents, x.commissionCents])).toEqual([["2026-09-30", 3334, 501], ["2026-10-01", 3334, 500], ["2026-10-02", 3333, 500]]);
    const [sep, oct] = kpiByMonth(["2026-09", "2026-10"], n);
    expect([sep.soldNights, sep.grossRoomCents, sep.netRoomCents]).toEqual([1, 3334, 2833]);
    expect([oct.soldNights, oct.grossRoomCents, oct.netRoomCents]).toEqual([2, 6667, 5667]);
    expect(computeKpi({ from: "2026-09-01", to: "2026-11-01" }, n)).toMatchObject({ grossRoomCents: 10001, netRoomCents: 8500, soldNights: 3 });
  });
  it("arrondi des KPI à la demi-unité : 0,5 monte (RevPAN 12 345 / 2 jours = 6 172,5 → 6 173)", () => {
    const k = computeKpi({ from: "2026-09-01", to: "2026-09-03" }, [{ night: "2026-09-01", channel: "AIRBNB", grossRoomCents: 12345, commissionCents: 0, paymentFeeCents: null }]);
    expect(k.grossRevpanCents).toBe(6173);
  });
});

describe("réconciliation ligne à ligne contre la source", () => {
  it("l'échantillon de référence est conforme : 12 lignes, plus grand écart 0,46 %, pas d'écart inconnu", () => {
    const r = reconcile(rows());
    expect(r).toMatchObject({ status: "OK", sampleSize: 12, compared: 12, unknown: 0 });
    expect(r.maxGapPct).toBeCloseTo(0.46243, 4); // R11 : 80 / 17 300, relevé 17 300 contre 17 220 calculé
    expect(r.rows.find((x) => x.id === "R08")).toMatchObject({ gapCents: 60, status: "OK" });
    expect(r.rows.filter((x) => x.gapCents === 0)).toHaveLength(10);
    expect(r.aggregateGapPct).toBeCloseTo(0.04078, 4); // 140 / 343 330
    expect(r.rows.find((x) => x.id === "R11")!.signedGapCents).toBe(-80); // l'application est sous le relevé
    expect(r.unbounded).toBe(false);
  });
  it("le net de l'application = hébergement − commission − frais de paiement (frais absents : aucun frais)", () => {
    expect(appNetCents({ grossRoomCents: 22000, commissionCents: 3740, paymentFeeCents: 220 })).toBe(18040);
    expect(appNetCents({ grossRoomCents: 30000, commissionCents: 4500, paymentFeeCents: null })).toBe(25500);
  });
  it("tolérance exacte en centimes entiers : 1,00 % conforme, 1,01 % écart", () => {
    const one = (src: number, app: number) => reconcile([{ id: "x", channel: "AIRBNB", app: { grossRoomCents: app, commissionCents: 0, paymentFeeCents: null }, sourceNetRoomCents: src }], 1, 1);
    expect(one(10000, 10100).status).toBe("OK");
    expect(one(10000, 9900).status).toBe("OK");
    expect(one(10000, 10101).status).toBe("GAP");
    expect(one(10000, 9899).status).toBe("GAP");
    expect(one(10000, 10000).maxGapPct).toBe(0);
  });
  it("un écart au-dessus de 1 % sur une seule ligne fait échouer l'échantillon, même si la moyenne est bonne", () => {
    const bad = rows(); bad[4] = { ...bad[4], sourceNetRoomCents: 25800 }; // +1,16 % sur R05 (300 / 25 800)
    const r = reconcile(bad);
    expect(r.status).toBe("GAP");
    expect(r.rows.find((x) => x.id === "R05")!.status).toBe("GAP");
    expect(r.aggregateGapPct!).toBeLessThan(1);
  });
  it("inconnu n'est pas zéro : commission inconnue ou relevé absent = ligne inconnue, échantillon non attestable", () => {
    const a = rows(); a[0] = { ...a[0], app: { ...a[0].app, commissionCents: null } };
    const b = rows(); b[1] = { ...b[1], sourceNetRoomCents: null };
    for (const s of [a, b]) {
      const r = reconcile(s);
      expect(r).toMatchObject({ status: "UNKNOWN", unknown: 1, compared: 11, sampleSize: 12 });
      expect(toAttestation(r, "relevés")).toBeNull();
    }
  });
  it("échantillon trop petit : moins de 10 lignes comparées", () => {
    const r = reconcile(rows().slice(0, 9));
    expect(r.status).toBe("TOO_SMALL");
    expect(toAttestation(r, "relevés Airbnb et Booking")).toMatchObject({ sampleSize: 9 });
    expect(reconciliationState({ payload: toAttestation(r, "relevés")!, validatedByName: "Test", createdAt: "2026-11-22T00:00:00Z" }).status).toBe("TOO_SMALL");
  });
  it("net de source nul : conforme seulement si l'application trouve aussi zéro", () => {
    const z = (app: number) => reconcile([{ id: "z", channel: "AIRBNB", app: { grossRoomCents: app, commissionCents: 0, paymentFeeCents: null }, sourceNetRoomCents: 0 }], 1, 1);
    expect(z(0).status).toBe("OK");
    expect(z(5).status).toBe("GAP");
    expect(toAttestation(z(5), "x")).toBeNull(); // écart infini : pas d'attestation chiffrée
    expect(z(5).unbounded).toBe(true); // distinct de « inconnu » une fois sérialisé (maxGapPct devient null en JSON)
    expect(JSON.parse(JSON.stringify(z(5)))).toMatchObject({ status: "GAP", maxGapPct: null, unbounded: true });
  });
  it("paramètres invalides refusés, jamais pris pour un succès ; échantillon vide non conforme", () => {
    expect(() => reconcile([], 1, 0)).toThrow(); expect(() => reconcile([], 1, NaN)).toThrow();
    expect(() => reconcile([], NaN)).toThrow(); expect(() => reconcile([], -1)).toThrow(); expect(() => reconcile([], 0.5)).toThrow();
    expect(reconcile([]).status).toBe("TOO_SMALL");
  });
  it("un écart l'emporte sur une ligne inconnue ; tolérance 0 : seule l'égalité parfaite est conforme", () => {
    const s = rows(); s[0] = { ...s[0], app: { ...s[0].app, commissionCents: null } }; s[4] = { ...s[4], sourceNetRoomCents: 26000 };
    expect(reconcile(s).status).toBe("GAP");
    expect(reconcile(rows(), 0).status).toBe("GAP"); // R08 et R11 diffèrent
    expect(reconcile(rows().filter((r) => !["R08", "R11"].includes(r.id)), 0, 10).status).toBe("OK");
  });
  it("l'attestation de l'échantillon de référence passe la validation de la checklist de qualité et la satisfait", () => {
    const att = toAttestation(reconcile(rows()), "Relevés Airbnb et Booking comparés à SuperHote", "échantillon de référence")!;
    expect(att).toEqual({ sampleSize: 12, maxGapPct: 0.47, source: "Relevés Airbnb et Booking comparés à SuperHote", note: "échantillon de référence" }); // 0,462 arrondi par excès
    expect(att.maxGapPct).toBeGreaterThanOrEqual(reconcile(rows()).maxGapPct!);
    expect(parseReconciliation({ ...att })).toMatchObject({ ok: true });
    expect(reconciliationState({ payload: att, validatedByName: "Test", createdAt: "2026-11-22T00:00:00Z" })).toMatchObject({ status: "OK", sampleSize: 12 });
  });
});

describe("cohérence de bout en bout : planchers ↔ simulateur ↔ KPI", () => {
  const M: EconomicModel = { ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } }, seasons: [{ id: "ete", label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 }] };
  it("vendre au plancher laisse la contribution visée à ±1 % : absolu, stratégique et saisonnier, 2 canaux × 3 durées", () => {
    for (const g of seasonalFloorGrid(M)) {
      const at = (price: number, from: string) => simulate({ model: M, channel: g.channel, nights: g.nights, stayFrom: from, publishedNightlyCents: price, maxDiscountStackPct: 100 });
      const hard = at(g.hardCents, "2026-03-10").result.contributionPerNightCents;
      const strat = at(g.strategyCents, "2026-03-10").result.contributionPerNightCents;
      const season = at(g.seasons[0].strategyCents, "2026-07-10").result.contributionPerNightCents;
      expect(hard).toBeGreaterThanOrEqual(3000); expect(hard).toBeLessThanOrEqual(3000 * 1.01);
      expect(strat).toBeGreaterThanOrEqual(4000); expect(strat).toBeLessThanOrEqual(4000 * 1.01);
      expect(season).toBeGreaterThanOrEqual(6000); expect(season).toBeLessThanOrEqual(6000 * 1.01);
      // un centime de moins sous le plancher absolu : la contribution passe sous le seuil (le plancher est bien le minimum)
      expect(at(g.hardCents - Math.ceil(g.nights * 2), "2026-03-10").result.contributionPerNightCents).toBeLessThan(3000);
    }
  });
  it("le plancher de la grille égale le calcul direct, et la cascade se referme au centime", () => {
    for (const g of seasonalFloorGrid(M)) {
      expect(g.hardCents).toBe(floorGrossNightlyCents(M, g.channel, g.nights, 3000));
      expect(g.seasons[0].strategyCents).toBe(floorGrossNightlyCents(M, g.channel, g.nights, 6000));
    }
    expect(simulate({ model: M, channel: "BOOKING", nights: 7, stayFrom: "2026-07-10", publishedNightlyCents: 11000, maxDiscountStackPct: 30 }).reconciles).toBe(true);
  });
  it("le net que simule le simulateur pour une réservation de l'échantillon est celui des KPI (hors ménage)", () => {
    // R09 : 7 nuits Booking à 110 € = 77 000 ; commission 17 % + frais 1 % : net 63 140, soit le net de l'échantillon
    const s = simulate({ model: M, channel: "BOOKING", nights: 7, stayFrom: "2026-10-18", publishedNightlyCents: 11000, maxDiscountStackPct: 30 });
    const r09 = REFERENCE_SAMPLE.find((r) => r.id === "R09")!;
    expect(s.result.netRoomCents).toBe(r09.sourceNetRoomCents);
    expect(s.result.netRoomCents).toBe(appNetCents(r09));
  });
});

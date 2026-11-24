import { describe, expect, it } from "vitest";
import type { MonthKpi } from "../engine/metrics";
import { euro, pct } from "../format";
import { buildSnapshot, checkNarrative, draftNarrative, findUncertifiedNumbers, isReportableMonth, numbersIn, parseNumber, reportableMonths, trendOf, type ReportAction, type SnapshotInput } from "./monthly";

const kpi = (over: Partial<MonthKpi> = {}): MonthKpi => ({ month: "2026-10", nights: 20, available: 31, blockedNights: 0, occupancy: 20 / 31, grossCents: 300000, netCents: 255000, adrCents: 15000, netAdrCents: 12750, netRevpanCents: 8226, byChannel: { AIRBNB: 155000, BOOKING: 100000 }, netIncomplete: false, netStatus: "COMPLETE", ...over });
const action = (over: Partial<ReportAction> = {}): ReportAction => ({ code: "S-2610-01", label: "Séjour minimal abaissé", outcome: "POSITIVE", summary: "6 nuits réservées en 7 jours (0,9 par jour) contre 2 attendues.", interpretation: "Corrélation.", reasons: [], legacy: false, ...over });
const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  month: "2026-10", now: new Date("2026-11-03T08:00:00Z"), property: { id: "p1", name: "T3 Châtillon", isDemo: false },
  current: kpi(), previous: kpi({ month: "2026-09", nights: 15, occupancy: 0.5, netCents: 200000, netAdrCents: 13300, netRevpanCents: 6666 }),
  market: { occupancy: 0.58, days: 31 }, actions: [action(), action({ code: "S-2610-02", outcome: "INCONCLUSIVE", reasons: ["RESERVATIONS_STALE"], summary: "Aucune comparaison possible." })],
  decisions: { total: 4, noAction: 1, rejected: 0, approved: 3 }, open: [{ code: "S-2611-01", title: "Week-end creux", option: "Promotion Booking", veto: false }], ...over,
});

describe("trendOf", () => {
  it("croissante / stable / décroissante à ±3 %, inconnue sans référence", () => {
    expect(trendOf(104, 100)).toBe("croissante");
    expect(trendOf(103, 100)).toBe("stable");
    expect(trendOf(97, 100)).toBe("stable");
    expect(trendOf(96, 100)).toBe("décroissante");
    expect(trendOf(100, 0)).toBe("inconnue");
    expect(trendOf(null, 100)).toBe("inconnue");
    expect(trendOf(100, null)).toBe("inconnue");
  });
});

describe("buildSnapshot", () => {
  it("un net partiel n'est jamais complété : le net par nuit disponible et les tendances nettes deviennent inconnus", () => {
    const s = buildSnapshot(input({ current: kpi({ netIncomplete: true, netStatus: "PARTIAL" }) }));
    expect(s.kpis.netRevpanCents).toBeNull();
    expect(s.trends.net).toBe("inconnue");
    expect(s.trends.netRevpan).toBe("inconnue");
    expect(s.kpis.netCents).toBe(255000);
  });
  it("aucune commission connue : net inconnu (null), jamais 0", () => {
    const s = buildSnapshot(input({ current: kpi({ netStatus: "UNKNOWN", netIncomplete: true, netCents: 0, netAdrCents: null, byChannel: {} }) }));
    expect(s.kpis.netCents).toBeNull();
    expect(s.channels).toEqual([]);
  });
  it("sans mois précédent : tendances inconnues ; écart au marché seulement si les deux occupations sont connues", () => {
    const s = buildSnapshot(input({ previous: null, market: { occupancy: null, days: 3 } }));
    expect(s.previous).toBeNull();
    expect(Object.values(s.trends)).toEqual(["inconnue", "inconnue", "inconnue", "inconnue"]);
    expect(s.market.gapPts).toBeNull();
    expect(buildSnapshot(input()).market.gapPts).toBe(Math.round((20 / 31 - 0.58) * 100));
  });
  it("compte les résultats par catégorie et classe les canaux par revenu net", () => {
    const s = buildSnapshot(input());
    expect(s.outcomes).toEqual({ POSITIVE: 1, NEUTRAL: 0, NEGATIVE: 0, INCONCLUSIVE: 1 });
    expect(s.channels.map((c) => c.channel)).toEqual(["AIRBNB", "BOOKING"]);
    expect(s.channels[0].share).toBeCloseTo(155 / 255, 5);
  });
  it("la contribution et l'objectif sont dits inconnus", () => {
    const s = buildSnapshot(input());
    expect(s.unknowns.contribution).toMatch(/non calculée/);
    expect(s.unknowns.objective).toMatch(/inconnu/);
  });
});

describe("draftNarrative", () => {
  it("le texte assemblé ne contient AUCUN nombre hors instantané, dans tous les cas de figure", () => {
    const cases: Partial<SnapshotInput>[] = [
      {}, { previous: null }, { actions: [] }, { open: [] }, { market: { occupancy: null, days: 0 } },
      { current: kpi({ netIncomplete: true, netStatus: "PARTIAL" }) },
      { current: kpi({ netStatus: "UNKNOWN", netIncomplete: true, netCents: 0, netAdrCents: null, byChannel: {} }) },
      { current: kpi({ nights: 0, available: 31, occupancy: 0, netCents: 0, byChannel: {} }) },
      { decisions: { total: 0, noAction: 0, rejected: 0, approved: 0 }, open: [] },
    ];
    for (const c of cases) {
      const s = buildSnapshot(input(c));
      expect(findUncertifiedNumbers(draftNarrative(s), s), JSON.stringify(c)).toEqual([]);
    }
  });
  it("dit les faits marquants et la tendance nommée, sans énumérer tous les chiffres", () => {
    const s = buildSnapshot(input());
    const t = draftNarrative(s);
    expect(t).toContain("tendance croissante");
    expect(t).toContain(euro(255000));
    expect(t).toContain("Airbnb");
    expect(t).toMatch(/aucun effet n'est attribué/);
    expect(t).toContain(pct(20 / 31));
  });
  it("un mois sans nuit vendue ne fabrique aucune performance", () => {
    const t = draftNarrative(buildSnapshot(input({ current: kpi({ nights: 0, occupancy: 0, byChannel: {} }) })));
    expect(t).toMatch(/Aucune nuit vendue/);
    expect(t).toMatch(/Aucun chiffre n'est estimé/);
  });
});

describe("garde-fou des nombres", () => {
  const s = buildSnapshot(input());
  it("lit les nombres français : milliers, virgule décimale, espaces insécables", () => {
    expect(parseNumber("1 234,56")).toBe(1234.56);
    expect(parseNumber("1 234")).toBe(1234);
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("2026")).toBe(2026);
    expect(numbersIn("255 000 € dont 12,5 % et 3 nuits").map((n) => n.value)).toEqual([255000, 12.5, 3]);
  });
  it("accepte les valeurs de l'instantané sous leurs écritures usuelles (euros, pourcentages, centimes, arrondis)", () => {
    for (const t of [`Revenu net ${euro(255000)}`, `occupation ${pct(20 / 31)}`, `occupation ${pct(20 / 31, 1)}`, "Prix moyen net 127,50 €", "20 nuits sur 31", "tendance par rapport à septembre 2026", "4 décisions"])
      expect(findUncertifiedNumbers(t, s), t).toEqual([]);
  });
  it("refuse un nombre inventé et les nomme", () => {
    expect(findUncertifiedNumbers("Le revenu net a progressé de 37 % grâce à nos actions.", s)).toEqual(["37"]);
    expect(findUncertifiedNumbers("Gain de 4 321 € attribué à la promotion.", s)).toEqual(["4 321"]);
    const r = checkNarrative(`Résultat : 987 nuits.\n\n${s.unknowns.contribution} ${s.unknowns.objective} aucun effet n'est attribué.`, s);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.numbers).toEqual(["987"]); expect(r.error).toMatch(/987/); }
  });
  it("texte vide ou trop long refusé, jamais tronqué ; texte valide accepté et nettoyé", () => {
    expect(checkNarrative("   ", s).ok).toBe(false);
    expect(checkNarrative("x".repeat(6001), s).ok).toBe(false);
    const keep = `${s.unknowns.contribution} ${s.unknowns.objective} Sans période témoin, aucun effet n'est attribué aux actions.`;
    const ok = checkNarrative(`  20 nuits vendues.\r\n\r\nTendance stable.\n\n${keep}  `, s);
    expect(ok).toEqual({ ok: true, text: `20 nuits vendues.\n\nTendance stable.\n\n${keep}` });
  });
  it("les nombres des textes certifiés (résumés des mesures, codes de dossier) comptent comme certifiés", () => {
    expect(findUncertifiedNumbers("Dossier S-2610-01 : 6 nuits en 7 jours.", s)).toEqual([]);
  });
});

describe("mois ouverts à un rapport", () => {
  it("seulement les mois terminés, du plus récent au plus ancien, sur 24 mois", () => {
    const m = reportableMonths("2026-11-24");
    expect(m[0]).toBe("2026-10");
    expect(m).toHaveLength(24);
    expect(m[23]).toBe("2024-11");
    expect(isReportableMonth("2026-11", "2026-11-24")).toBe(false);
    expect(isReportableMonth("2026-10", "2026-11-24")).toBe(true);
    expect(isReportableMonth("2024-10", "2026-11-24")).toBe(false);
    expect(reportableMonths("2026-01-05")[0]).toBe("2025-12");
  });
});

describe("contournements du garde-fou (relecture US-112)", () => {
  const s = buildSnapshot(input());
  const KEEP = `${s.unknowns.contribution} ${s.unknowns.objective} Sans période témoin, aucun effet n'est attribué aux actions.`;
  it("le texte automatique passe toujours la vérification complète", () => {
    for (const c of [{}, { previous: null }, { actions: [] }, { current: kpi({ netIncomplete: true, netStatus: "PARTIAL" }) }, { current: kpi({ nights: 0, occupancy: 0, byChannel: {}, netCents: 0 }) }]) {
      const sn = buildSnapshot(input(c));
      const r = checkNarrative(draftNarrative(sn), sn);
      expect(r.ok, JSON.stringify(c) + JSON.stringify(r)).toBe(true);
    }
  });
  it("apostrophes, espaces fines et chiffres pleine chasse ne cachent plus un nombre inventé", () => {
    expect(findUncertifiedNumbers("1'000'000 €", s)).toEqual(["1 000 000"]);
    expect(findUncertifiedNumbers("1\u2009000\u2009000 €", s)).toEqual(["1 000 000"]);
    expect(findUncertifiedNumbers("１２３４５ €", s)).toEqual(["12345"]);
    expect(findUncertifiedNumbers("٣٧ nuits", s)).toEqual(["٣٧"]);
  });
  it("les nombres en lettres sont refusés, « un » reste permis", () => {
    expect(findUncertifiedNumbers("Environ douze mille euros, soit la moitié.", s)).toEqual(["douze", "mille", "moitié"]);
    expect(findUncertifiedNumbers("Un seul canal domine.", s)).toEqual([]);
  });
  it("un montant ou un pourcentage doit venir d'une métrique de même nature (facteur 100 refusé)", () => {
    expect(findUncertifiedNumbers("Revenu brut 3 000 €.", s)).toEqual([]);
    expect(findUncertifiedNumbers("Revenu brut 300 000 €.", s)).toEqual(["300 000"]);
    expect(findUncertifiedNumbers("Revenu brut 30 €.", s)).toEqual(["30"]);
    expect(findUncertifiedNumbers("Occupation de 6 500 %.", s)).toEqual(["6 500"]);
  });
  it("deux nombres séparés par une espace ne fusionnent plus", () => {
    expect(numbersIn("octobre 2026 12 nuits").map((n) => n.value)).toEqual([2026, 12]);
  });
  it("un texte retouché garde les mentions d'inconnues et n'attribue aucun effet", () => {
    expect(checkNarrative("Mois calme.", s)).toMatchObject({ ok: false, error: expect.stringMatching(/Contribution non calculée/) });
    expect(checkNarrative(`Grâce à nos actions, le revenu a progressé.\n\n${KEEP}`, s)).toMatchObject({ ok: false, error: expect.stringMatching(/attribue un effet/) });
    expect(checkNarrative(`Mois calme.\n\n${s.unknowns.contribution} ${s.unknowns.objective}`, s)).toMatchObject({ ok: false, error: expect.stringMatching(/aucun effet n'est attribué/) });
    expect(checkNarrative(`Mois calme.\n\n${KEEP}`, s).ok).toBe(true);
    const partial = buildSnapshot(input({ current: kpi({ netIncomplete: true, netStatus: "PARTIAL" }) }));
    expect(checkNarrative(`Mois calme.\n\n${KEEP}`, partial)).toMatchObject({ ok: false, error: expect.stringMatching(/partiel/) });
  });
  it("un mois sans nuit vendue ne fabrique ni revenu ni occupation à zéro", () => {
    const e = buildSnapshot(input({ current: kpi({ nights: 0, occupancy: 0, netCents: 0, netAdrCents: null, netRevpanCents: 0, byChannel: {} }) }));
    expect(e.kpis.netCents).toBeNull();
    expect(e.kpis.occupancy).toBeNull();
    expect(e.kpis.netRevpanCents).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { freeNightsPhrase, NEXT_NIGHTS, nextNights } from "./next-nights";

const TODAY = "2026-11-28";
type State = "FREE" | "BOOKED" | "BLOCKED";
const day = (i: number, state: State = "FREE", priceCents: number | null = 10000, recommendedPriceCents: number | null = null) => ({ date: addDays(TODAY, i), state, priceCents, recommendedPriceCents });
const opp = (code: string, from: number, to: number, o: Partial<{ veto: boolean; priority: number; playbook: string }> = {}) => ({ code, title: `Titre ${code}`, playbook: "PB-01", veto: false, priority: 1, ...o, stayFrom: addDays(TODAY, from), stayTo: addDays(TODAY, to) });
const AIRBNB = { key: "airbnb", label: "Airbnb", pct: 15 };

describe("nextNights", () => {
  it("rend quatorze nuits à partir d'aujourd'hui ; une nuit absente du calendrier est « non lue »", () => {
    const { nights } = nextNights([day(-1), day(0), day(2, "BOOKED"), day(3, "BLOCKED"), day(30)], [], null, TODAY);
    expect(nights).toHaveLength(NEXT_NIGHTS);
    expect(nights[0]).toEqual({ date: TODAY, state: "FREE", priceCents: 10000, flag: null });
    expect(nights.slice(1, 4).map((n) => n.state)).toEqual(["UNKNOWN", "BOOKED", "BLOCKED"]);
    expect(nights.at(-1)!.date).toBe(addDays(TODAY, 13));
  });
  it("prix des seules nuits libres : jamais sur une nuit réservée ou bloquée, jamais zéro quand il manque", () => {
    const { nights } = nextNights([day(0, "BOOKED", 9000), day(1, "BLOCKED", 9000), day(2, "FREE", null)], [], null, TODAY);
    expect(nights.slice(0, 3).map((n) => n.priceCents)).toEqual([null, null, null]);
  });
  it("même règle de prix que le calendrier : estimé sur le canal à partir du prix recommandé", () => {
    const { nights } = nextNights([day(0, "FREE", 10000), day(1, "FREE", null, 9000), day(2, "FREE", null, null)], [], AIRBNB, TODAY);
    expect(nights.slice(0, 3).map((n) => n.priceCents)).toEqual([11500, 10400, null]);
  });
  it("signale les nuits libres sous un dossier ouvert, le veto l'emportant ; ni PB-10 ni PB-13", () => {
    const days = [day(0), day(1, "BOOKED"), day(2), day(3)];
    const { nights, situations } = nextNights(days, [opp("A", 0, 3), opp("V", 2, 3, { veto: true }), opp("D", 0, 14, { playbook: "PB-10" }), opp("M", 0, 14, { playbook: "PB-13" })], null, TODAY);
    expect(nights.slice(0, 4).map((n) => n.flag)).toEqual(["open", null, "veto", null]);
    expect(situations.map((s) => [s.code, s.nights.length])).toEqual([["V", 1], ["A", 2]]);
  });
  it("classe les situations : vetos d'abord, puis priorité, puis date ; ignore celles sans nuit libre dans la fenêtre", () => {
    const days = Array.from({ length: 20 }, (_, i) => day(i, i === 5 ? "BOOKED" : "FREE"));
    const { situations } = nextNights(days, [opp("BASSE", 0, 2, { priority: 1 }), opp("HAUTE", 8, 9, { priority: 9 }), opp("VETO", 10, 11, { veto: true, priority: 0 }), opp("RESERVEE", 5, 6, { priority: 99 }), opp("LOIN", 15, 18)], null, TODAY);
    expect(situations.map((s) => s.code)).toEqual(["VETO", "HAUTE", "BASSE"]);
  });
});

describe("freeNightsPhrase", () => {
  it.each([
    [["2026-12-06"], "Libre le 6 déc."],
    [["2026-12-06", "2026-12-07"], "Libres les 6 et 7 déc."],
    [["2026-11-30", "2026-12-01"], "Libres les 30 nov. et 1 déc."],
    [["2026-12-06", "2026-12-07", "2026-12-08", "2026-12-09"], "Libres du 6 au 9 déc."],
    [["2026-11-29", "2026-11-30", "2026-12-01"], "Libres du 29 nov. au 1 déc."],
    [["2026-12-02", "2026-12-04", "2026-12-09"], "Libres les 2, 4 et 9 déc."],
    [["2026-11-28", "2026-12-01", "2026-12-04"], "Libres les 28 nov., 1 et 4 déc."],
    [["2026-12-01", "2026-12-02", "2026-12-04", "2026-12-06", "2026-12-08"], "5 nuits libres entre le 1 et le 8 déc."],
  ])("%j → %s", (dates, phrase) => expect(freeNightsPhrase(dates)).toBe(phrase));
});

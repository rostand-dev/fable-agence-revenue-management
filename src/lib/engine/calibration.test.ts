import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { calibration, CALIBRATION, trendOf, type CalRow } from "./calibration";

const T = "2026-11-25";
const d = (n: number) => new Date(addDays(T, n) + "T10:00:00Z");
const row = (playbook: string, ago: number, decision: string | null = null, status = decision ? "DECIDED" : "OPEN"): CalRow => ({ playbook, status, decision, createdAt: d(-ago) });
const line = (rows: CalRow[], code: string) => calibration(rows, T).find((l) => l.code === code)!;

describe("calibrage des playbooks", () => {
  it("couvre les 13 playbooks actifs, sans dossier = silencieux", () => {
    const all = calibration([], T);
    expect(all).toHaveLength(13);
    expect(all.every((l) => l.verdict === "SILENCIEUX" && l.trend === "INSUFFISANT")).toBe(true);
  });
  it("tendance : trop peu de dossiers, hausse, stable, baisse, apparition", () => {
    expect(trendOf(1, 1)).toBe("INSUFFISANT");
    expect(trendOf(6, 4)).toBe("CROISSANTE"); // 1,5 exactement
    expect(trendOf(5, 4)).toBe("STABLE");
    expect(trendOf(3, 4)).toBe("STABLE");
    expect(trendOf(2, 3)).toBe("DECROISSANTE"); // 2/3 exactement : borne incluse
    expect(trendOf(2, 4)).toBe("DECROISSANTE");
    expect(trendOf(3, 0)).toBe("CROISSANTE");
  });
  it("fenêtres : 30 derniers jours contre les 30 précédents ; au-delà de 90 jours, ignoré", () => {
    const rows = [row("PB-01", 1), row("PB-01", 29), row("PB-01", 30), row("PB-01", 45), row("PB-01", 59), row("PB-01", 61), row("PB-01", 100)];
    const l = line(rows, "PB-01");
    expect(l).toMatchObject({ recent: 2, previous: 3, total: 6 });
  });
  it("taux d'approbation : inconnu sous 5 décisions, jamais zéro", () => {
    const rows = [row("PB-02", 5, "APPROVED"), row("PB-02", 6, "REJECTED"), row("PB-02", 7, "APPROVED")];
    expect(line(rows, "PB-02")).toMatchObject({ approvalRate: null, verdict: "EN_OBSERVATION", approved: 2, rejected: 1 });
  });
  it("souvent refusé : seuil trop sensible ; presque toujours approuvé sur assez de cas : trop prudent", () => {
    const refused = [...Array(4).fill(0).map((_, i) => row("PB-03", 3 + i, "REJECTED")), ...Array(2).fill(0).map((_, i) => row("PB-03", 10 + i, "APPROVED"))];
    expect(line(refused, "PB-03")).toMatchObject({ verdict: "TROP_SENSIBLE" });
    const stamped = Array(9).fill(0).map((_, i) => row("PB-04", 3 + i, "APPROVED_SHADOW")).concat([row("PB-04", 20, "REJECTED")]);
    expect(line(stamped, "PB-04")).toMatchObject({ verdict: "TROP_PRUDENT" });
    const mixed = [...Array(4).fill(0).map((_, i) => row("PB-05", 3 + i, "APPROVED")), ...Array(2).fill(0).map((_, i) => row("PB-05", 10 + i, "REJECTED"))];
    expect(line(mixed, "PB-05")).toMatchObject({ verdict: "RAS" });
  });
  it("« ne rien faire » n'entre pas dans le taux ; les dossiers ouverts sont comptés à part", () => {
    const rows = [...Array(6).fill(0).map((_, i) => row("PB-06", 3 + i, "APPROVED")), row("PB-06", 2, "NO_ACTION"), row("PB-06", 1)];
    expect(line(rows, "PB-06")).toMatchObject({ approvalRate: 1, noAction: 1, open: 1 });
  });
  it("seuils de calibrage nommés et cohérents", () => {
    expect(CALIBRATION.declineRatio).toBeLessThan(1);
    expect(CALIBRATION.growthRatio).toBeGreaterThan(1);
    expect(CALIBRATION.rubberStampMinDecisions).toBeGreaterThanOrEqual(CALIBRATION.minDecisions);
  });
  it("verdicts aux bornes : 5 décisions mini, refus à 60 %, accord à 90 % avec 8 décisions, expirés à 60 %", () => {
    const mk = (a: number, r: number) => [...Array.from({ length: a }, () => row("PB-01", 5, "APPROVED")), ...Array.from({ length: r }, () => row("PB-01", 5, "REJECTED"))];
    expect(line(mk(3, 1), "PB-01").verdict).toBe("EN_OBSERVATION");
    expect(line(mk(2, 3), "PB-01").verdict).toBe("TROP_SENSIBLE");
    expect(line(mk(7, 1), "PB-01").verdict).toBe("RAS");
    expect(line(mk(8, 0), "PB-01").verdict).toBe("TROP_PRUDENT");
    expect(line(mk(7, 0), "PB-01").verdict).toBe("RAS");
    const exp = [...Array.from({ length: 3 }, () => row("PB-01", 5, null, "EXPIRED")), ...Array.from({ length: 2 }, () => row("PB-01", 5))];
    expect(line(exp, "PB-01").verdict).toBe("IGNORE");
  });
});

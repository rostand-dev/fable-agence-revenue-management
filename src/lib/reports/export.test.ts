import { describe, expect, it } from "vitest";
import { BOM, csvCell, historyCsv, measuresCsv, reportCsv, toCsv, type ExportedReport } from "./csv";
import { reportPdf } from "./document";
import { buildPdf, winAnsi, wrap } from "./pdf";
import { buildSnapshot, draftNarrative } from "./monthly";
import { slug } from "./filters";
import { reportBlocks } from "./document";

const kpi: any = { month: "2026-10", nights: 20, available: 31, blockedNights: 0, occupancy: 20 / 31, grossCents: 300000, netCents: 255000, adrCents: 15000, netAdrCents: 12750, netRevpanCents: 8226, byChannel: { AIRBNB: 155000, BOOKING: 100000 }, netIncomplete: false, netStatus: "COMPLETE" };
const snap = buildSnapshot({ month: "2026-10", now: new Date("2026-11-03T08:00:00Z"), property: { id: "p1", name: "T3 Châtillon = test", isDemo: false }, current: kpi, previous: null, market: { occupancy: null, days: 0 },
  actions: [{ code: "S-2610-01", label: "Séjour minimal abaissé", outcome: "INCONCLUSIVE", summary: "Aucune comparaison possible.", interpretation: "Rien n'est supposé.", reasons: ["RESERVATIONS_STALE"], legacy: false }], decisions: { total: 0, noAction: 0, rejected: 0, approved: 0 }, open: [] });
const rep: ExportedReport = { month: "2026-10", version: 2, status: "CERTIFIED", narrative: draftNarrative(snap), certifiedAt: new Date("2026-11-04T10:00:00Z"), certifiedByName: "Rosy", certifiedHash: "ab".repeat(32), snapshot: snap };

describe("CSV (US-113)", () => {
  it("neutralise les formules, protège séparateurs, guillemets et retours à la ligne", () => {
    expect(csvCell("=CMD()")).toBe("'=CMD()");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=x")).toBe("'\t=x");
    expect(csvCell("-12,5")).toBe("-12,5");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell("l1\nl2")).toBe("l1 ⏎ l2");
    expect(csvCell(12.5)).toBe("12,5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });
  it("BOM, séparateur ; et CRLF", () => {
    const t = toCsv([["a", "b"], [1, 2]]);
    expect(t.startsWith(BOM)).toBe(true);
    expect(t).toBe(BOM + "a;b\r\n1;2\r\n");
  });
  it("le rapport exporte les mêmes valeurs que l'instantané, les inconnues en toutes lettres, jamais un zéro", () => {
    const t = reportCsv(rep);
    expect(t).toContain("Revenu net;2550;€;");
    expect(t).toContain("Occupation du marché;inconnu;%");
    expect(t).toContain("Effet incrémental des actions;inconnu");
    expect(t).toContain("Version;2");
    expect(t).toContain("Certifié par;Rosy");
    expect(t).not.toMatch(/\n=/);
    expect(t).toContain("Airbnb;1550;");
    expect(t).toContain("S-2610-01;Séjour minimal abaissé;Non concluant");
  });
  it("un net inconnu s'exporte « inconnu »", () => {
    const s2 = buildSnapshot({ ...{ month: "2026-10", now: new Date(), property: { id: "p", name: "X", isDemo: false }, previous: null, market: { occupancy: null, days: 0 }, actions: [], decisions: { total: 0, noAction: 0, rejected: 0, approved: 0 }, open: [] }, current: { ...kpi, netStatus: "UNKNOWN", netIncomplete: true, netCents: 0, byChannel: {} } });
    expect(reportCsv({ ...rep, snapshot: s2 })).toContain("Revenu net;inconnu;€");
  });
  it("historiques : une ligne par version et par mesure", () => {
    const h = historyCsv("T3", [{ month: "2026-10", version: 1, status: "CERTIFIED", certifiedAt: new Date("2026-11-01T00:00:00Z"), certifiedByName: "Rosy", certifiedHash: "x" }, { month: "2026-10", version: 2, status: "DRAFT", certifiedAt: null, certifiedByName: null, certifiedHash: null }]);
    expect(h.trim().split("\r\n")).toHaveLength(3);
    expect(h).toContain("T3;2026-10-01;2;Brouillon;;;");
    const m = measuresCsv("T3", [{ code: "S-1", label: "=HYPERLINK()", outcome: "POSITIVE", reasons: [], observeFrom: null, observeTo: null, summary: "ok", interpretation: "corrélation", confidence: "faible", legacy: true, id: "m1", measuredAt: new Date("2026-11-01T00:00:00Z") }]);
    expect(m).toContain("'=HYPERLINK()");
    expect(m).toContain("Positif");
    expect(m).toContain("inconnu;inconnu");
    expect(m).toContain(";oui;");
  });
});

describe("PDF (US-113)", () => {
  it("WinAnsi : accents, euro, espaces insécables ; le reste devient « ? »", () => {
    expect(winAnsi("é")).toBe(0xe9);
    expect(winAnsi("€")).toBe(0x80);
    expect(winAnsi(" ")).toBe(0x20);
    expect(winAnsi("中")).toBe(0x3f);
  });
  it("coupe les lignes à la largeur, y compris un mot plus long que la ligne", () => {
    const lines = wrap("un texte assez long pour passer à la ligne plusieurs fois de suite", 10.5, 120);
    expect(lines.length).toBeGreaterThan(2);
    expect(wrap("x".repeat(200), 10.5, 100).length).toBeGreaterThan(1);
  });
  it("document valide : en-tête, table xref aux bons décalages, nombre de pages, pagination automatique", () => {
    const pdf = reportPdf(rep);
    const txt = pdf.toString("latin1");
    expect(txt.startsWith("%PDF-1.4")).toBe(true);
    expect(txt.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(txt)![1]);
    expect(txt.slice(start, start + 4)).toBe("xref");
    const n = Number(/xref\n0 (\d+)/.exec(txt.slice(start))![1]);
    const entries = [...txt.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(n - 1);
    entries.forEach((off, i) => expect(txt.slice(off, off + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`));
    const long = buildPdf(Array.from({ length: 200 }, (_, i) => ({ kind: "para" as const, text: `Ligne ${i}` })), { title: "t" }).toString("latin1");
    expect(Number(/\/Count (\d+)/.exec(long)![1])).toBeGreaterThan(2);
  });
  it("le texte est lisible : accents et euro encodés, parenthèses et barres obliques échappées", () => {
    const pdf = buildPdf([{ kind: "para", text: "Café (été) 2 550 € \\ ok" }], { title: "t" }).toString("latin1");
    expect(pdf).toContain("Caf\\351 \\(\\351t\\351\\) 2 550 \\200 \\\\ ok");
  });
});

describe("relecture US-113", () => {
  const base = { month: "2026-10", now: new Date("2026-11-03T08:00:00Z"), property: { id: "p", name: "X", isDemo: false }, previous: null, actions: [], decisions: { total: 0, noAction: 0, rejected: 0, approved: 0 }, open: [] };
  it("PDF : écart au marché inconnu (aucune nuit vendue, marché connu) n'est jamais écrit « 0 point »", () => {
    const s = buildSnapshot({ ...base, current: { ...kpi, nights: 0, occupancy: 0, netCents: 0, byChannel: {} }, market: { occupancy: 0.6, days: 31 } });
    const row = reportBlocks({ ...rep, snapshot: s }).find((b) => b.kind === "row" && b.label === "Marché") as any;
    expect(row.value).toBe("écart au marché inconnu");
  });
  it("CSV : un net partiel est dit partiel, y compris par canal", () => {
    const s = buildSnapshot({ ...base, current: { ...kpi, netIncomplete: true, netStatus: "PARTIAL" }, market: { occupancy: null, days: 0 } });
    const t = reportCsv({ ...rep, snapshot: s });
    expect(t).toContain("Revenu net complet;non : commission inconnue");
    expect(t).toContain("Airbnb;1550;60,8;net partiel");
    expect(reportCsv(rep)).toContain("Revenu net complet;oui");
  });
  it("heures de Paris : une certification à 23 h 30 UTC tombe le lendemain à Paris", () => {
    const t = reportCsv({ ...rep, certifiedAt: new Date("2026-11-04T23:30:00Z") });
    expect(t).toContain("Certifié le;2026-11-05 00:30");
    const pdf = reportBlocks({ ...rep, certifiedAt: new Date("2026-11-04T23:30:00Z") })[1] as any;
    expect(pdf.text).toContain("certifié le 2026-11-05");
  });
  it("CSV : nom de logement commençant par « = » neutralisé, mois en clair à la date du 1er, mesures avec la mention de lecture", () => {
    expect(historyCsv("=X()", [{ month: "2026-10", version: 1, status: "CERTIFIED", certifiedAt: null, certifiedByName: null, certifiedHash: null }])).toContain("'=X();2026-10-01;1");
    expect(csvCell("-0,5")).toBe("-0,5");
    expect(measuresCsv("T3", [{ id: "m", code: "S", label: "a", outcome: "NEGATIVE", reasons: [], observeFrom: "2026-10-01", observeTo: "2026-10-15", summary: "s", interpretation: "i", confidence: "faible", legacy: false, measuredAt: new Date("2026-12-31T23:30:00Z") }])).toMatch(/2027-01-01 00:30;aucun effet n'est attribué|2027-01-01 00:30;observation/);
  });
  it("noms de fichiers : ASCII sûr, jamais vide", () => {
    expect(slug("T3 Châtillon (Paris) — « test »")).toBe("t3-chatillon-paris-test");
    expect(slug("../../etc")).toBe("etc");
    expect(slug("中文")).toBe("logement");
    expect(slug("x".repeat(100)).length).toBe(30);
  });
  it("PDF : un titre contenant le tiret cadratin et des accents majuscules ne dépasse pas la marge", () => {
    const lines = wrap("ÉÉÉÉÉ — — — — — — ÉÉÉÉÉ — — — — — — ÉÉÉÉÉ — — — — — —", 10.5, 200);
    expect(lines.length).toBeGreaterThan(1);
  });
});

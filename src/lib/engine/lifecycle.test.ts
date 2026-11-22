import { describe, expect, it } from "vitest";
import { PLAYBOOKS } from "./playbooks";
import { cooldownDaysOf, cooldownLabel, dedupeOpportunities, endOfCooldown, groupKeys, openingDecision } from "./lifecycle";

const NOW = new Date("2026-11-20T08:00:00Z");
const daysAgo = (n: number) => new Date(+NOW - n * 86400000);

describe("période de repos", () => {
  it("lit la durée du catalogue, 14 jours si le playbook est inconnu", () => {
    expect(cooldownDaysOf("PB-01")).toBe(PLAYBOOKS["PB-01"].cooldownDays);
    expect(cooldownDaysOf("PB-99")).toBe(14);
  });
  it("sans dossier précédent ou après expiration : on crée", () => {
    expect(openingDecision(undefined, "PB-01", NOW)).toEqual({ action: "CREATE" });
    expect(openingDecision({ status: "EXPIRED", createdAt: daysAgo(3) }, "PB-01", NOW)).toEqual({ action: "CREATE" });
  });
  it("un dossier ouvert est rafraîchi, pas dupliqué", () => {
    expect(openingDecision({ status: "OPEN", createdAt: daysAgo(3) }, "PB-01", NOW)).toEqual({ action: "REFRESH" });
  });
  it("un dossier différé reste fermé jusqu'à son échéance", () => {
    expect(openingDecision({ status: "DEFERRED", createdAt: daysAgo(3), deferUntil: "2026-11-25" }, "PB-01", NOW)).toEqual({ action: "SKIP", reason: "DEFERRED", until: "2026-11-25" });
  });
  it("une décision récente met le signal au repos, comptée depuis la décision et non l'ouverture", () => {
    const cd = cooldownDaysOf("PB-01");
    const r = openingDecision({ status: "DECIDED", createdAt: daysAgo(cd + 5), decidedAt: daysAgo(cd - 1) }, "PB-01", NOW);
    expect(r).toMatchObject({ action: "SKIP", reason: "COOLDOWN" });
  });
  it("le repos se termine pile à l'échéance", () => {
    const cd = cooldownDaysOf("PB-01");
    expect(openingDecision({ status: "DECIDED", createdAt: daysAgo(40), decidedAt: daysAgo(cd) }, "PB-01", NOW)).toEqual({ action: "CREATE" });
    expect(openingDecision({ status: "DECIDED", createdAt: daysAgo(40), decidedAt: daysAgo(cd + 1) }, "PB-01", NOW)).toEqual({ action: "CREATE" });
  });
  it("sans date de décision (ancien dossier), la date d'ouverture sert de repli", () => {
    expect(openingDecision({ status: "DECIDED", createdAt: daysAgo(1) }, "PB-01", NOW)).toMatchObject({ action: "SKIP", reason: "COOLDOWN" });
    expect(openingDecision({ status: "DECIDED", createdAt: daysAgo(90) }, "PB-01", NOW)).toEqual({ action: "CREATE" });
  });
  it("chaque playbook a sa propre durée", () => {
    const a = openingDecision({ status: "DECIDED", createdAt: daysAgo(40), decidedAt: daysAgo(10) }, "PB-01", NOW);
    const long = Object.values(PLAYBOOKS).find((p) => p.cooldownDays > 10)!;
    const short = Object.values(PLAYBOOKS).find((p) => p.cooldownDays <= 10);
    expect(a.action === "SKIP" || a.action === "CREATE").toBe(true);
    expect(openingDecision({ status: "DECIDED", createdAt: daysAgo(40), decidedAt: daysAgo(10) }, long.code, NOW).action).toBe("SKIP");
    if (short) expect(openingDecision({ status: "DECIDED", createdAt: daysAgo(40), decidedAt: daysAgo(10) }, short.code, NOW).action).toBe("CREATE");
  });
  it("libellé et échéance", () => {
    expect(cooldownLabel("2026-11-26")).toBe("jusqu'au 26/11/2026");
    expect(endOfCooldown(new Date("2026-11-20T23:30:00Z"), "PB-01")).toBe("2026-12-04");
  });
});

describe("déduplication dans une revue", () => {
  const o = (playbook: string, dedupe: string | null, stayFrom: string, score: number) => ({ playbook, dedupe, stayFrom, score });
  it("garde le plus prioritaire d'une même clé, dans l'ordre d'origine", () => {
    const list = [o("PB-01", "D8_14", "2026-11-22", 10), o("PB-03", null, "2026-11-23", 5), o("PB-01", "D8_14", "2026-11-22", 30)];
    const r = dedupeOpportunities(list, (x) => x.score);
    expect(r.map((x) => x.score)).toEqual([5, 30]);
  });
  it("sans clé, deux dossiers de dates différentes restent distincts", () => {
    const r = dedupeOpportunities([o("PB-03", null, "2026-11-23", 1), o("PB-03", null, "2026-11-30", 1)], (x) => x.score);
    expect(r).toHaveLength(2);
  });
  it("à égalité, garde la nuit la plus proche", () => {
    const r = dedupeOpportunities([o("PB-02", "k", "2026-12-05", 4), o("PB-02", "k", "2026-12-01", 4)], (x) => x.score);
    expect(r.map((x) => x.stayFrom)).toEqual(["2026-12-01"]);
  });
});

describe("regroupement", () => {
  it("regroupe les séjours qui se chevauchent ou se touchent, isole les autres", () => {
    const keys = groupKeys([
      { stayFrom: "2026-11-25", stayTo: "2026-11-28" },
      { stayFrom: "2026-11-20", stayTo: "2026-11-25" }, // touche le suivant : fin exclusive = début
      { stayFrom: "2026-12-10", stayTo: "2026-12-12" },
      { stayFrom: "2026-11-27", stayTo: "2026-12-02" }, // chevauche le premier
    ], "p1");
    expect(keys[0]).toBe("p1|2026-11-20");
    expect(keys[1]).toBe("p1|2026-11-20");
    expect(keys[3]).toBe("p1|2026-11-20");
    expect(keys[2]).toBe("p1|2026-12-10");
  });
  it("un dossier seul a sa propre clé ; liste vide acceptée", () => {
    expect(groupKeys([{ stayFrom: "2026-11-20", stayTo: "2026-11-21" }], "p")).toEqual(["p|2026-11-20"]);
    expect(groupKeys([], "p")).toEqual([]);
  });
  it("un séjour qui en englobe un autre ne change pas la clé du groupe", () => {
    const k = groupKeys([{ stayFrom: "2026-11-20", stayTo: "2026-12-20" }, { stayFrom: "2026-12-01", stayTo: "2026-12-03" }, { stayFrom: "2026-12-19", stayTo: "2026-12-22" }], "p");
    expect(new Set(k).size).toBe(1);
  });
});

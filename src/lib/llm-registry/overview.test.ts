import { describe, expect, it } from "vitest";
import { costTrend, modelState } from "./overview";

const base = { lifecycle: "ACTIVE" as const, hasPending: false, available: true, tasksTotal: 4, tasksQualified: 0, tasksSuspended: 0 };

describe("état affiché d'un modèle", () => {
  it("la déprécation prime sur tout le reste", () => {
    for (const lifecycle of ["DEPRECATED", "RETIRED", "ABSENT"] as const) expect(modelState({ ...base, lifecycle, hasPending: true, tasksQualified: 4 })).toBe("deprecie");
  });
  it("un prix en attente passe avant la qualification", () => expect(modelState({ ...base, hasPending: true, tasksQualified: 4 })).toBe("prix_a_verifier"));
  it("hors de la liste de la clé : non disponible", () => expect(modelState({ ...base, available: false, tasksQualified: 4 })).toBe("indisponible"));
  it("qualifié seulement si TOUTES les tâches le sont et qu'aucune n'est suspendue", () => {
    expect(modelState({ ...base, tasksQualified: 4 })).toBe("qualifie");
    expect(modelState({ ...base, tasksQualified: 3 })).toBe("disponible");
    expect(modelState({ ...base, tasksQualified: 3, tasksSuspended: 1 })).toBe("disponible");
    expect(modelState({ ...base, tasksTotal: 0 })).toBe("disponible");
  });
});

describe("tendance du coût (rythme journalier, mois en cours contre mois précédent)", () => {
  const now = new Date(Date.UTC(2026, 10, 15, 12)); // 15 novembre : octobre a 31 jours
  it("aucune dépense des deux côtés", () => expect(costTrend(0, 0, now)).toBe("aucun"));
  it("dépense sans mois précédent : croissante", () => expect(costTrend(1, 0, now)).toBe("croissante"));
  it("dépense qui s'arrête : décroissante", () => expect(costTrend(0, 3.1, now)).toBe("decroissante"));
  it("même rythme : stable ; la bande est de 15 %", () => {
    expect(costTrend(14.5, 31, now)).toBe("stable");      // 1 $/j contre 1 $/j (14,5 jours écoulés)
    expect(costTrend(16.5, 31, now)).toBe("stable");      // +10 %
    expect(costTrend(18, 31, now)).toBe("croissante");    // +20 %
    expect(costTrend(12, 31, now)).toBe("decroissante");  // −20 %
  });
  it("un mois entamé n'est pas comparé en cumul : 5 $ en 15 jours contre 8 $ sur 31 jours est une hausse", () => expect(costTrend(5, 8, now)).toBe("croissante"));
});

import { describe, expect, it } from "vitest";
import { trimToLastSentence } from "./text";

describe("trimToLastSentence", () => {
  it("garde un texte qui finit sur une phrase complète", () => {
    expect(trimToLastSentence("Je lis les données. Je ne modifie rien.")).toBe("Je lis les données. Je ne modifie rien.");
  });
  it("coupe à la dernière phrase complète quand le texte est tronqué", () => {
    expect(trimToLastSentence("Je suis l'agent de contrôle des prix. Je travaille en lecture seule et je")).toBe("Je suis l'agent de contrôle des prix.");
  });
  it("sans phrase exploitable, garde le texte et marque la coupure", () => {
    expect(trimToLastSentence("Je travaille en lecture seule et je,")).toBe("Je travaille en lecture seule et je …");
  });
  it("ne coupe pas sur une abréviation en milieu de phrase suivie d'un mot collé", () => {
    expect(trimToLastSentence("Le tarif passe de 120 à 135 € la nuit, soit +12.5% sur la période. Je recommande d'atte")).toBe("Le tarif passe de 120 à 135 € la nuit, soit +12.5% sur la période.");
  });
});

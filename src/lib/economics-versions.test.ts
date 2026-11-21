import { describe, expect, it } from "vitest";
import { diffEconomics } from "./economics-versions";
import { emptyEconomics } from "./engine/economics";
import type { EconomicModel } from "./engine/types";

const model = (o: Partial<EconomicModel> = {}): EconomicModel => ({ ...emptyEconomics(), channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1.4 } }, cleaningFeeChargedCents: 6000, ...o });

describe("versions du modèle économique (US-022)", () => {
  it("première version : tout ce qui est renseigné est listé, l'inconnu n'est pas inventé", () => {
    const c = diffEconomics(null, model());
    expect(c.map((x) => x.key)).toEqual(["channels.AIRBNB.commissionPct", "channels.AIRBNB.paymentFeePct", "channels.BOOKING.commissionPct", "channels.BOOKING.paymentFeePct", "cleaningFeeChargedCents"]);
    expect(c.find((x) => x.key === "channels.AIRBNB.commissionPct")).toMatchObject({ from: null, to: "15,5 %" });
    expect(c.some((x) => x.key === "cleaningCostCents")).toBe(false);
  });
  it("l'origine n'est comparée que si elle était connue : pas d'« avant » inventé", () => {
    expect(diffEconomics({} as EconomicModel, model()).some((x) => x.key === "origin")).toBe(false);
    expect(diffEconomics(model({ origin: "DEMO" }), model())).toContainEqual({ key: "origin", label: "Origine des valeurs", from: "démonstration", to: "déclarées" });
  });
  it("aucun changement : rien à versionner ; un seul changement : une seule ligne, en clair", () => {
    expect(diffEconomics(model(), model())).toEqual([]);
    expect(diffEconomics(model(), model({ cleaningFeeChargedCents: 7000 }))).toEqual([{ key: "cleaningFeeChargedCents", label: "Frais de ménage facturés", from: "60,00 €", to: "70,00 €" }]);
  });
  it("une valeur qui devient inconnue est signalée, une commission de canal retirée aussi", () => {
    const c = diffEconomics(model(), model({ cleaningFeeChargedCents: null, channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } } }));
    expect(c.map((x) => [x.key, x.to])).toEqual([["channels.BOOKING.commissionPct", null], ["channels.BOOKING.paymentFeePct", null], ["cleaningFeeChargedCents", null]]);
  });
  it("les réponses brutes du parcours et les estimations provisoires ne créent pas de version à elles seules", () => {
    expect(diffEconomics(model({ answers: { a: "1" }, provisional: [] }), model({ answers: { a: "2" }, provisional: ["hard"] }))).toEqual([]);
  });
});

import { Term } from "@/components/Term";
import { Recap, Vq } from "@/components/ui";
import { fmtDate, fmtPeriod } from "@/lib/dates";
import { BASELINE_LIMIT_LABEL, COMPARABLE_REASON_LABEL, netPerNight, type Baseline } from "@/lib/experiments/baseline";
import { euro, pct } from "@/lib/format";
import { EXPERIMENT_STATUS_LABEL, isLegacyBaseline, windowsOf, type ExperimentRow, type ExperimentStatus } from "@/lib/services/experiments";

const nights = (n: number) => `${n} nuit${n > 1 ? "s" : ""}`;
const perDay = (x: number) => `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} nuit${x >= 2 ? "s" : ""} par jour`;

/**
 * Expérience d'une action (US-110) : la référence figée AVANT l'effet de l'action et les fenêtres de mesure.
 * Lecture seule. Une donnée absente s'affiche « inconnue », jamais comme un zéro ; une baseline insuffisante dit pourquoi.
 */
export function ExperimentPanel({ experiment }: { experiment: ExperimentRow }) {
  const x = experiment, b = x.baseline;
  const w = windowsOf(x);
  const status = EXPERIMENT_STATUS_LABEL[x.status as ExperimentStatus] ?? x.status;
  const common: [React.ReactNode, React.ReactNode, boolean?][] = [
    ["État", status],
    ["Entrée en vigueur", fmtDate(x.effectiveOn), true],
    ["Observation", w.observation ? `${fmtPeriod(w.observation.from, w.observation.to)} (jusqu'à la veille de la mesure)` : <Vq>pas encore fixée</Vq>, true],
  ];
  if (isLegacyBaseline(b)) {
    return (
      <div className="experiment" data-testid="experiment-panel" data-legacy="true">
        <h4>Expérience</h4>
        <Recap rows={[...common, ["Référence", <Vq key="r">non figée</Vq>]]} />
        <p className="muted" style={{ margin: "8px 0 0" }} data-testid="experiment-limits">Cette action est antérieure au suivi des expériences : la référence n'a pas été figée à l'époque et ne s'invente pas après coup. Sa mesure restera non concluante.</p>
      </div>
    );
  }
  const base = b as Baseline;
  const net = base.pickup ? netPerNight(base.pickup) : null;
  const rows: [React.ReactNode, React.ReactNode, boolean?][] = [
    ...common,
    ["Nuits visées", base.stay ? `${fmtPeriod(base.stay.from, base.stay.to)} · ${nights(base.stay.nights)} à vendre` : <Vq>toutes passées</Vq>, true],
    ["Fenêtre de référence", `${fmtPeriod(base.window.from, base.window.to)} · ${base.window.days} jours avant l'action`, true],
    [<Term key="p" id="pickup">Rythme de référence</Term>, base.pickup ? `${nights(base.pickup.nights)} réservées, soit ${perDay(base.pickup.perDay)}` : <Vq>inconnu</Vq>],
    ["Net par nuit", net === null ? <Vq>inconnu</Vq> : `${euro(net)}${base.pickup && base.pickup.netNights < base.pickup.nights ? ` (sur ${nights(base.pickup.netNights)} au net connu)` : ""}`],
    ["Occupation des séjours visés", base.onBooks?.occupancy == null ? <Vq>inconnue</Vq> : `${pct(base.onBooks.occupancy)} (${base.onBooks.bookedNights} réservées sur ${base.onBooks.availableNights} disponibles)`],
    ["Même période l'an passé", base.comparable.available ? `${nights(base.comparable.pickupNights ?? 0)} réservées sur la même fenêtre, 52 semaines plus tôt` : <Vq>{COMPARABLE_REASON_LABEL[base.comparable.reason ?? "NO_HISTORY"]}</Vq>],
  ];
  return (
    <div className="experiment" data-testid="experiment-panel" data-sufficient={base.sufficient ? "true" : "false"}>
      <h4>Expérience</h4>
      <Recap rows={rows} />
      {base.sufficient
        ? <p className="muted" style={{ margin: "8px 0 0" }}>Référence figée le {fmtDate(base.asOf)}, avant l'effet de l'action : elle ne change plus.</p>
        : <p className="muted" style={{ margin: "8px 0 0" }} data-testid="experiment-limits">Référence insuffisante : {base.limits.map((l) => BASELINE_LIMIT_LABEL[l]).join(" ; ")}. La mesure restera non concluante plutôt que de comparer à un faux zéro.</p>}
    </div>
  );
}

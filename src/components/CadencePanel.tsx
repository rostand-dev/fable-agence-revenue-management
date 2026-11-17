import { Term } from "@/components/Term";
import { Recap, State, Vq } from "@/components/ui";
import { fmtDateTime } from "@/lib/dates";
import { CADENCE_LABEL, everyLabel, type CadenceLevel } from "@/lib/engine/cadence";

type Props = {
  cadence: Record<string, any> | null;
  isDemo: boolean; hasPriceLabs: boolean; hasSuperhote: boolean;
  nextReservationsAt: Date | null; nextPricesAt: Date | null; nextReviewAt: Date | null;
  now: Date;
};

export const CADENCE_ROLE: Record<CadenceLevel, "attention" | "tech" | "sain" | "neutre"> = { SOUTENU: "attention", ACTIF: "tech", REGULIER: "sain", CALME: "neutre" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Prochaine échéance en clair. Une échéance passée ou absente sera traitée au prochain passage du planificateur (toutes les 15 min). */
function nextLabel(d: Date | null, now: Date, what: string): string {
  return d && +d > +now ? `${what} ${fmtDateTime(d)}` : `${what} au prochain passage, sous 15 minutes`;
}

/** Rythme de suivi d'un logement : palier, raisons en clair, et les trois échéances (réservations, prix et marché, revue). */
export function CadencePanel({ cadence: c, isDemo, hasPriceLabs, hasSuperhote, nextReservationsAt, nextPricesAt, nextReviewAt, now }: Props) {
  if (!c?.level) {
    return (
      <section className="section">
        <h2><Term id="rythme-de-suivi">Rythme de suivi</Term></h2>
        <p className="muted">Le rythme de ce logement sera calculé au prochain passage de l'équipe, sous 15 minutes.</p>
      </section>
    );
  }
  const level = c.level as CadenceLevel, reasons: string[] = c.reasons ?? [];
  const failed = (f?: { n: number }) => (f?.n ? ` · dernière lecture en échec (${f.n} tentative${f.n > 1 ? "s" : ""}), nouvel essai automatique` : "");
  const rows: [React.ReactNode, React.ReactNode][] = [
    ["Réservations et disponibilités", isDemo ? "Données de démonstration, pas de lecture" : hasSuperhote
      ? <>{cap(everyLabel(c.reservationsEveryH))} chez SuperHote · {nextLabel(nextReservationsAt, now, "prochaine lecture")}{failed(c.failures?.sh)}</>
      : hasPriceLabs ? "Lues en même temps que PriceLabs, tant que SuperHote n'est pas connecté" : <Vq>source non connectée</Vq>],
    ["Prix et marché", isDemo ? "Données de démonstration, pas de lecture" : hasPriceLabs
      ? <>{c.awaitingGrid ? "Toutes les 3 h en attendant le calcul nocturne de PriceLabs" : cap(everyLabel(c.pricesEveryH)) + " chez PriceLabs"} · {nextLabel(nextPricesAt, now, "prochaine lecture")}{failed(c.failures?.pl)}</>
      : <Vq>PriceLabs non connecté</Vq>],
    ["Revue par les agents", <>{cap(everyLabel(c.reviewEveryH))} · {c.lastReviewAt ? `dernière ${fmtDateTime(new Date(c.lastReviewAt))} · ` : ""}{nextLabel(nextReviewAt, now, "prochaine")}</>],
  ];
  return (
    <section className="section">
      <h2><Term id="rythme-de-suivi">Rythme de suivi</Term></h2>
      <p className="section-note">La fréquence des lectures et des revues s'adapte à la dynamique de ce logement et de son marché. Elle est recalculée après chaque lecture.</p>
      <div className="cadence-head">
        <State role={CADENCE_ROLE[level]}>{CADENCE_LABEL[level]}</State>
        {reasons.length > 0 && <p className="cadence-why">{cap(reasons.join(" · "))}.</p>}
      </div>
      <Recap rows={rows} />
      {!isDemo && (hasSuperhote || hasPriceLabs) && <p className="kpi-note">Une réservation ou une annulation relevée à la lecture relance la revue de ce logement sans attendre son échéance.</p>}
    </section>
  );
}

import Link from "next/link";
import { Banner, OppStatus, State, Vq } from "./ui";
import { fmtDay, todayISO } from "@/lib/dates";
import { STATE_LABEL, type ActionState } from "@/lib/engine/stateMachine";
import { OUTCOME } from "@/lib/labels";
import { viewHref } from "@/lib/nav";
import { RECENT_DECISIONS, type Decision } from "@/lib/queries";

/** États après lesquels aucune mesure n'est à attendre. */
const NOTHING_TO_MEASURE: ActionState[] = ["REJECTED", "FAILED", "ROLLED_BACK", "CANCELLED", "EXPIRED"];

/** Ce qu'une décision a produit : la mesure quand elle existe, sinon l'état de l'action, sinon rien à mesurer. */
function Result({ d }: { d: Decision }) {
  const a = d.action;
  if (!a) return <span className="pk-decision-result">{d.decision === "REJECTED" || d.decision === "NO_ACTION" ? "Aucune action à mesurer" : <Vq>pas encore mesuré</Vq>}</span>;
  const m = a.measurement;
  if (m) {
    const [label, role] = OUTCOME[m.outcome] ?? [m.outcome, "neutre"];
    return <span className="pk-decision-result"><State role={role}>{label}</State>{m.observed && <span className="pk-decision-observed">{m.observed}</span>}</span>;
  }
  const state = a.status as ActionState;
  return <span className="pk-decision-result">{STATE_LABEL[state]}{!NOTHING_TO_MEASURE.includes(state) && <> · <Vq>pas encore mesuré</Vq></>}</span>;
}

/**
 * Historique en mode poche : les dernières décisions et leur résultat.
 * Le journal d'audit et ses filtres restent à la version complète : le journal n'est pas lu ici.
 */
export function PocketHistory({ decisions, names, audit, journalReturn }: {
  decisions: Decision[]; names: Map<string, string>;
  /** null : le rôle lit le journal ; sinon le motif du refus */ audit: string | null;
  /** page à rouvrir en version complète, à la hauteur du journal */ journalReturn: string;
}) {
  return (
    <div className="pk-screen pk-history" data-testid="historique-poche">
      <div className="pk-head">
        <h1>Dernières décisions</h1>
        <p>{decisions.length === RECENT_DECISIONS ? `les ${RECENT_DECISIONS} plus récentes` : decisions.length > 0 ? `${decisions.length} au total` : ""}</p>
      </div>
      {decisions.length === 0 ? <p className="pk-card pk-empty">Aucune décision pour l'instant. Vos approbations, rejets et inactions apparaîtront ici.</p> : (
        <ul className="pk-list-cards pk-decisions" data-testid="pk-decisions">
          {decisions.map((d) => (
            <li key={d.id}>
              <Link href={`/dossier/${d.code}`} className="pk-sit pk-decision" data-testid="pk-decision">
                <span className="pk-sit-top"><OppStatus status={d.status} decision={d.decision} actionStatus={d.action?.status} /><span className="pk-sit-ref">{d.code} · {fmtDay(todayISO(d.decidedAt!))}</span></span>
                <span className="pk-sit-title">{d.action?.label ?? d.title}</span>
                <span className="pk-decision-asset">{names.get(d.propertyId)} · {fmtDay(d.stayFrom)} → {fmtDay(d.stayTo)}</span>
                <Result d={d} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="pk-note">Une réservation survenue après une action n'est pas présentée comme causée par elle. Les dossiers expirés se consultent en version complète. <Link href="/?f=traitees" className="pk-note-link">Dossiers traités et différés</Link></p>
      <section id="journal" aria-labelledby="pk-journal-h">
        <h2 id="pk-journal-h" className="pk-section-title">Journal d'audit, filtres et mesures</h2>
        {audit && <div data-testid="journal-reserve"><Banner role="tech" icon="shield" title="Journal réservé">{audit}</Banner></div>}
        <a className="pk-actions-line" href={viewHref("complet", journalReturn)} data-testid="pk-version-complete">
          <span>{audit ? "Tableau des actions : version complète" : "Journal d'audit et filtres : version complète"}</span>
          <span aria-hidden="true">›</span>
        </a>
      </section>
    </div>
  );
}

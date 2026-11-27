import Link from "next/link";
import { approveAction, deferAction, reviewAction } from "@/app/actions/decisions";
import { fmtDay } from "@/lib/dates";
import type { Candidate } from "@/lib/engine/types";
import { signedEuro } from "@/lib/format";
import type { OppWithAction } from "@/lib/queries";
import { approveLabel, quickApprovable, situationRole } from "@/lib/situation";
import { CardMenu } from "./CardMenu";
import { ActionForm, Submit } from "./forms";
import { Icon } from "./Icon";
import { confidenceScale, OppStatus, riskScale, State, Vq } from "./ui";

/**
 * Mode poche : une situation en une carte courte. Mêmes actions serveur et mêmes droits que `SitCard` ;
 * l'approbation n'est proposée ici que pour une option conforme (voir `quickApprovable`), sinon la carte mène au dossier.
 */
export function SitCardCompact({ o, rank, propertyName, provisional, canDecide }: { o: OppWithAction; rank: number | null; propertyName: string; provisional?: boolean; canDecide: boolean }) {
  const c = (o.candidates as Candidate[])[o.selected];
  const { role, label } = situationRole(o, c);
  const open = o.status === "OPEN";
  const quick = quickApprovable(o, c, canDecide);
  const conf = confidenceScale(o.confidence).label.toLowerCase(), risk = riskScale(o.risk).label.toLowerCase();
  const dossier = `/dossier/${o.code}`;
  return (
    <article className={`pk-sit${o.veto ? " is-veto" : ""}${open ? "" : " is-settled"}`} aria-labelledby={`t-${o.id}`} data-testid="situation">
      <div className="pk-sit-top">
        <State role={role}>{label}</State>
        <span className="pk-sit-ref">{rank !== null ? `#${rank} · ` : ""}{o.code}</span>
      </div>
      <h2 className="pk-sit-title" id={`t-${o.id}`}><Link href={dossier}>{o.title}</Link></h2>
      <p className="pk-sit-asset"><span>{propertyName}</span><span className="pk-sit-dates">· {fmtDay(o.stayFrom)} → {fmtDay(o.stayTo)}</span></p>
      <p className="pk-sit-option">
        <span className="pk-sit-option-label">→ {c.label}</span>
        <span className="pk-sit-impact">
          {c.type === "NO_ACTION" ? "aucune écriture" : c.expectedDeltaCents === null ? <Vq kind="nonchiffrable">non chiffrable</Vq> : `${signedEuro(c.expectedDeltaCents)} simulés`}
        </span>
      </p>
      <p className="pk-sit-gauges">Confiance {conf} · Risque {risk}{provisional ? " · planchers provisoires" : ""}</p>
      {!open && <p className="pk-sit-status"><OppStatus status={o.status} decision={o.decision} actionStatus={o.action?.status} /></p>}
      <div className="pk-sit-actions">
        {open && canDecide && (
          <CardMenu label={`Autres actions pour ${o.code}`}>
            {!o.veto && <ActionForm action={deferAction} hidden={{ opportunityId: o.id }}><Submit className="btn btn-ghost" icon="clock">Différer de 3 jours</Submit></ActionForm>}
            <ActionForm action={reviewAction}><Submit className="btn btn-ghost" icon="spin" pendingLabel="Revue en cours…">Relancer la revue</Submit></ActionForm>
          </CardMenu>
        )}
        {quick ? (
          <ActionForm action={approveAction} hidden={{ opportunityId: o.id, candidate: o.selected, comment: "" }} className="pk-sit-main">
            <Submit icon={c.type === "NO_ACTION" ? "pause" : "check"}>{approveLabel(c)}</Submit>
          </ActionForm>
        ) : open && canDecide ? (
          <div className="pk-sit-main"><Link className="btn btn-primary" href={`${dossier}#decision`}><Icon name="folder" />Arbitrer</Link></div>
        ) : (
          <div className="pk-sit-main"><Link className="btn btn-ghost" href={dossier}><Icon name="folder" />{open ? "Ouvrir le dossier" : "Voir le dossier"}</Link></div>
        )}
      </div>
    </article>
  );
}

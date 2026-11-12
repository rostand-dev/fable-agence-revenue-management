import Link from "next/link";
import { approveAction, deferAction } from "@/app/actions/decisions";
import { fmtPeriod } from "@/lib/dates";
import type { Candidate } from "@/lib/engine/types";
import { signedEuro } from "@/lib/format";
import type { OppWithAction } from "@/lib/queries";
import { ActionForm, Submit } from "./forms";
import { Icon } from "./Icon";
import { Byline, confidenceScale, OppStatus, riskScale, State, Steps, Vq } from "./ui";

export function needsComment(c: Candidate) { return c.audit.verdict === "NEEDS_HUMAN" || c.risk === "HIGH" || c.risk === "CRITICAL"; }

export function SitCard({ o, rank, propertyName, names, provisional }: { o: OppWithAction; rank: number | null; propertyName: string; names?: Record<string, string> | null; provisional?: boolean }) {
  const c = (o.candidates as Candidate[])[o.selected];
  const conf = confidenceScale(o.confidence), risk = riskScale(o.risk);
  const open = o.status === "OPEN";
  const role = o.veto ? "veto" : o.playbook === "PB-10" ? "tech" : c.type === "NO_ACTION" ? "neutre" : c.audit.verdict === "NEEDS_HUMAN" ? "attention" : "sain";
  const roleLabel = o.veto ? "Veto économique" : o.playbook === "PB-10" ? "Donnée à vérifier" : c.type === "NO_ACTION" ? "Inaction recommandée" : c.audit.verdict === "NEEDS_HUMAN" ? "Validation renforcée" : "Option conforme";
  return (
    <article className={`sit${open ? "" : " is-settled"}`} aria-labelledby={`t-${o.id}`}>
      <div className="sit-rank">
        {rank !== null && <span className="sit-rank-no">Priorité #{rank}</span>}
        <State role={role}>{roleLabel}</State>
        <OppStatus status={o.status} decision={o.decision} actionStatus={o.action?.status} />
        <span className="tag tag-mono">{o.code}</span>
        <span className="tag">{o.playbook}</span>
        {provisional && <span className="tag" title="Certains coûts ou seuils de ce logement sont des estimations à confirmer">planchers provisoires</span>}
      </div>
      <div className="sit-body">
        <div className="sit-head">
          <div className="od-fill">
            <h3 className="sit-title" id={`t-${o.id}`}><Link href={`/dossier/${o.code}`} style={{ color: "inherit", textDecoration: "none" }}>{o.title}</Link></h3>
            <p className="sit-asset">{propertyName}</p>
          </div>
          <Byline agent={c.agent} names={names} what="a instruit l'option" />
        </div>
        <div className="chain">
          <div className="chain-step"><span className="chain-key"><Icon name="signal" />Signal</span><p className="chain-val">{o.signals.signalText}<br /><span className="amount-source">{o.signals.signalSource}</span></p></div>
          <div className="chain-step"><span className="chain-key"><Icon name="calendar" />Période</span><p className="chain-val mono">{fmtPeriod(o.stayFrom, o.stayTo)}</p></div>
          <div className="chain-step"><span className="chain-key"><Icon name="bulb" />Hypothèse</span><p className="chain-val">{o.signals.hypothesisText}</p></div>
          <div className="chain-step chain-step-option"><span className="chain-key"><Icon name="arrow" />Option</span><p className="chain-val">{c.label}</p></div>
        </div>
        <div className="gauges">
          <div className="gauge"><span className="gauge-label">Confiance du diagnostic</span>
            <span className="gauge-read gauge-conf"><strong>{conf.label}</strong><span className="gauge-num">{conf.level}/4</span></span>
            <Steps level={conf.level} cls="gauge-conf" /><span className="gauge-note">{o.diagnosis.confidenceNote}</span></div>
          <div className="gauge"><span className="gauge-label">Risque de l'option</span>
            <span className={`gauge-read gauge-risk-${risk.cls}`}><strong>{risk.label}</strong><span className="gauge-num">{risk.level}/4</span></span>
            <Steps level={risk.level} cls={`gauge-risk-${risk.cls}`} /><span className="gauge-note">{c.audit.rules.find((r) => r.outcome !== "PASS")?.detail ?? "Tous les garde-fous sont respectés."}</span></div>
        </div>
        <div className="sit-impact">
          <div className="amount">
            {c.type === "NO_ACTION" ? <><span className="gauge-label">Impact net simulé</span><span className="amount-value">aucune écriture</span><span className="amount-source">Réévaluation {c.reviewAt ? "le " + c.reviewAt.split("-").reverse().join("/") : "à la prochaine revue"}</span></>
              : c.expectedDeltaCents === null ? <><span className="gauge-label">Impact net simulé</span><Vq kind="nonchiffrable">Non chiffrable</Vq><span className="amount-source">{c.hypothesis}</span></>
              : <><span className="sim-flag">Écart de contribution (simulation)</span><span className="amount-value">{signedEuro(c.expectedDeltaCents)}</span><span className="amount-source">espérance sur la période, hypothèse de vente comprise</span></>}
          </div>
          {o.veto && o.signals.vetoText && <div className="amount od-fill"><span className="gauge-label">Motif du veto</span><span className="amount-source" style={{ fontSize: 13, color: "var(--quiet)" }}>{o.signals.vetoText}</span></div>}
        </div>
        <div className="sit-actions">
          {open && !needsComment(c) && (
            <ActionForm action={approveAction} hidden={{ opportunityId: o.id, candidate: o.selected, comment: "" }} className="inline">
              <Submit icon={c.type === "NO_ACTION" ? "pause" : "check"}>{c.type === "NO_ACTION" ? "Retenir l'inaction" : "Approuver"}</Submit>
            </ActionForm>
          )}
          {open && needsComment(c) && <Link className="btn btn-primary" href={`/dossier/${o.code}#decision`}><Icon name="folder" />Arbitrer dans le dossier</Link>}
          {open && !o.veto && (
            <ActionForm action={deferAction} hidden={{ opportunityId: o.id }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="clock">Différer de 3 jours</Submit></ActionForm>
          )}
          <span className="spacer" />
          <Link className="btn btn-ghost btn-sm" href={`/dossier/${o.code}`}><Icon name="folder" />{open ? "Ouvrir le dossier" : "Voir le dossier"}</Link>
        </div>
      </div>
    </article>
  );
}

import Link from "next/link";
import type { schema } from "@/db";
import { approvalRequirement, MIN_COMMENT_LENGTH } from "@/lib/engine/approval";
import type { Candidate } from "@/lib/engine/types";
import { fmtDate, fmtPeriod } from "@/lib/dates";
import { signedEuro } from "@/lib/format";
import { STATE_LABEL, type ActionState } from "@/lib/engine/stateMachine";
import { approveLabel, followUpPending, needsComment, situationRole, type DecisionOptions } from "@/lib/situation";
import { DecisionBar, ReopenBar } from "./DecisionBar";
import { DossierFold, ReturnToOutcome, RevealOnHash } from "./DossierFold";
import { Icon } from "./Icon";
import { Term } from "./Term";
import { confidenceScale, OppStatus, riskScale, State, Vq } from "./ui";

type Opportunity = typeof schema.opportunities.$inferSelect;

/** En-tête du dossier en mode poche : retour, code, logement et pastille (rôle de l'option affichée, ou état d'un dossier qui n'est plus ouvert). */
export function DossierHeader({ o, c, recommended, propertyName, actionStatus }: { o: Opportunity; c: Candidate; /** l'option affichée est l'option recommandée */ recommended: boolean; propertyName: string; actionStatus?: string | null }) {
  // les libellés de `situationRole` sont écrits pour l'option recommandée : une option seulement examinée, ou rejetée, se dit comme telle
  const s = situationRole(o, c);
  const { role, label } = !o.veto && c.audit.verdict === "REJECT" ? { role: "veto" as const, label: "Option rejetée" }
    : !recommended && s.label === "Inaction recommandée" ? { role: s.role, label: "Inaction examinée" } : s;
  return (
    <header className="topbar pk-topbar pk-dossier-head">
      <Link href="/" className="btn btn-ghost pk-back" aria-label="Retour aux opportunités"><Icon name="back" /></Link>
      <div>
        <p className="topbar-sub pk-code">{o.code} · {o.playbook}</p>
        <p className="topbar-title">{propertyName}</p>
      </div>
      <div className="pk-head-pill" data-testid="pk-pastille">
        {o.status === "OPEN" ? <State role={role}>{label}</State> : <OppStatus status={o.status} decision={o.decision} actionStatus={actionStatus} />}
      </div>
    </header>
  );
}

/**
 * Dossier en mode décision (mode poche) : la décision d'abord, le raisonnement à la demande.
 * Les sections repliées sont celles de la version complète, construites par la page : ce composant ne fait que les ranger.
 * Mêmes actions serveur et mêmes droits : les boutons permis viennent de `decisionOptions`.
 */
export function DossierDecision({ o, c, index, recommended, may, canDecide, banner, rejected, notes, readOnlyNote, followUp, folds, foot }: {
  o: Opportunity; c: Candidate; /** option affichée (`?option=`) : la barre agit sur elle */ index: number; recommended: boolean; may: DecisionOptions; canDecide: boolean;
  /** lecture seule, ou résultat d'un dossier qui n'est plus ouvert */ banner: React.ReactNode;
  rejected: React.ReactNode; notes: React.ReactNode; /** ce qui reste possible sans le droit de décision */ readOnlyNote: string;
  followUp: { node: React.ReactNode; status: string; alerts: number } | null;
  folds: { id: string; label: string; node: React.ReactNode }[];
  foot: React.ReactNode;
}) {
  const open = o.status === "OPEN";
  const conf = confidenceScale(o.confidence), risk = riskScale(c.risk);
  const optionKey = !open ? (o.decision === "REJECTED" ? "Option proposée" : o.decision ? "Option retenue" : "Option recommandée") : recommended ? "Option recommandée" : "Option examinée";
  const comment = may.approve && needsComment(c, o.playbook);
  return (
    <div className="pk-screen pk-dossier" data-testid="dossier-decision">
      <RevealOnHash />
      <ReturnToOutcome status={o.status} />
      {/* ancre `#decision` (lien « Arbitrer » des cartes) : le haut du dossier, la barre restant à l'écran */}
      <div className="pk-top" id="decision">
        <h1 id="pk-title" tabIndex={-1}>{o.title}</h1>
        {banner && <div id="pk-outcome" tabIndex={-1}>{banner}</div>}
        {o.veto && o.signals.vetoText && (
          <div className="pk-veto" data-testid="motif-veto">
            <h2 className="pk-key">Motif du <Term id="veto">veto</Term></h2>
            <p>{o.signals.vetoText}</p>
          </div>
        )}
        <dl className="pk-chain" data-testid="pk-resume">
          <div><dt>Signal</dt><dd>{o.signals.signalText}</dd></div>
          <div><dt>Période</dt><dd className="mono">{fmtPeriod(o.stayFrom, o.stayTo)}</dd></div>
          <div><dt>Hypothèse</dt><dd>{o.signals.hypothesisText}</dd></div>
          <div className="pk-chain-option">
            <dt>{optionKey}</dt>
            <dd>{c.type === "NO_ACTION" ? "Ne rien faire et réévaluer" : c.label}</dd>
            {open && !recommended && <dd><Link className="pk-return" href={`/dossier/${o.code}`}>Revenir à l'option recommandée</Link></dd>}
          </div>
        </dl>
        <div className="pk-tiles">
          <div className="pk-tile" data-testid="pk-impact">
            <h2 className="pk-key">Impact simulé</h2>
            {c.type === "NO_ACTION" ? <><strong>Aucune écriture</strong><span>Réévaluation {c.reviewAt ? `le ${fmtDate(c.reviewAt)}` : "à la prochaine revue"}</span></>
              : c.expectedDeltaCents === null ? <p><Vq kind="nonchiffrable">Non chiffrable</Vq></p>
              : <><strong className="mono">{signedEuro(c.expectedDeltaCents)}</strong><span>simulation, pas un revenu acquis</span></>}
          </div>
          <div className="pk-tile" data-testid="pk-jauges">
            <h2 className="pk-key"><Term id="confiance">Confiance</Term> · risque</h2>
            <strong>{conf.label} · <span className={`gauge-risk-${risk.cls}`}>{risk.label.toLowerCase()}</span></strong>
            <span>diagnostic · option affichée</span>
          </div>
        </div>
      </div>

      {open && (
        <section className="pk-before" aria-labelledby="pk-before-h" data-testid="avant-de-decider">
          <h2 className="pk-key" id="pk-before-h">Avant de décider</h2>
          {rejected && <div id="pk-rejected">{rejected}</div>}
          {notes}
          {comment && <p id="pk-comment-why">Commentaire obligatoire : {approvalRequirement(c, o.playbook).reasons.join(" ; ")}. Il est consigné au journal.</p>}
          <p>Retour arrière : {c.rollbackPlan || "sans objet"}</p>
          <p className="pk-before-note">{!canDecide ? readOnlyNote : o.veto ? "Un dossier sous veto ne peut pas être différé." : "Rejeter et différer sont consignés au journal."}</p>
        </section>
      )}

      <div className="pk-folds">
        {followUp && (
          <DossierFold id="suivi" label={`Suivi d'application · ${STATE_LABEL[followUp.status as ActionState] ?? followUp.status}`} defaultOpen={followUpPending(followUp.status, followUp.alerts)}>{followUp.node}</DossierFold>
        )}
        {folds.filter((f) => f.node).map((f) => <DossierFold key={f.id} id={f.id} label={f.label}>{f.node}</DossierFold>)}
      </div>
      {foot}

      {/* la clé change avec l'option affichée : un commentaire écrit pour une option n'est jamais envoyé avec une autre */}
      {may.reject
        ? <DecisionBar key={index} opportunityId={o.id} candidate={index} canApprove={may.approve} canDefer={may.defer} approveText={approveLabel(c)} minComment={comment ? MIN_COMMENT_LENGTH : null} />
        : may.reopen ? <ReopenBar opportunityId={o.id} /> : null}
    </div>
  );
}

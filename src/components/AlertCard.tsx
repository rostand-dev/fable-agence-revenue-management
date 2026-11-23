import Link from "next/link";
import { ActionForm, Submit } from "@/components/forms";
import { State } from "@/components/ui";
import { acknowledgeAlertAction, interruptStuckAction } from "@/app/actions/decisions";
import { fmtDateTime } from "@/lib/dates";
import { ALERT_KINDS, isAlertKind, type Alert } from "@/lib/services/execution-alerts";

/** Une alerte d'exécution : gravité, ce qui s'est passé, lien vers le dossier, et les gestes possibles (prendre en compte, marquer comme interrompue). */
export function AlertCard({ alert, property, code, canAct, emailOn }: { alert: Alert; property?: string; code?: string | null; canAct: boolean; emailOn: boolean }) {
  const label = isAlertKind(alert.kind) ? ALERT_KINDS[alert.kind].label : alert.kind;
  const resolved = alert.status === "RESOLVED", ack = alert.status === "ACKNOWLEDGED";
  return (
    <article className="card alert-card" data-testid="alert-card" data-kind={alert.kind} data-status={alert.status} aria-labelledby={`al-${alert.id}`}>
      <header className="alert-head">
        <State role={resolved ? "sain" : alert.severity === "CRITICAL" ? "veto" : "attention"}>{resolved ? "Résolue" : alert.severity === "CRITICAL" ? "Critique" : "À surveiller"}</State>
        <span className="muted">{label}</span>
        {ack && <State role="neutre">Prise en compte</State>}
      </header>
      <h3 id={`al-${alert.id}`} className="alert-title">{alert.title}</h3>
      <p className="alert-detail">{alert.detail}</p>
      <p className="muted alert-meta">
        {property ? `${property} · ` : ""}{fmtDateTime(alert.createdAt)}
        {resolved && alert.resolvedAt ? ` · résolue le ${fmtDateTime(alert.resolvedAt)}${alert.resolution ? ` (${alert.resolution})` : ""}` : ""}
        {!resolved && (alert.notifiedAt ? " · e-mail envoyé à l'équipe" : emailOn ? " · e-mail non envoyé" : " · e-mail non configuré : alerte visible ici uniquement")}
      </p>
      {!resolved && (
        <div className="alert-actions">
          {code && <Link className="btn btn-ghost btn-sm" href={`/dossier/${code}`}>Ouvrir le dossier</Link>}
          {canAct && alert.status === "OPEN" && <ActionForm action={acknowledgeAlertAction} hidden={{ alertId: alert.id }}><Submit className="btn btn-sm" icon="check">Prendre en compte</Submit></ActionForm>}
          {canAct && alert.kind === "STUCK" && alert.actionId && !alert.writeId && <ActionForm action={interruptStuckAction} hidden={{ actionId: alert.actionId }}><Submit className="btn btn-danger btn-sm" icon="undo">Marquer comme interrompue</Submit></ActionForm>}
        </div>
      )}
    </article>
  );
}

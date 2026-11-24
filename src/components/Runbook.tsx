import { toggleRunbookStepAction } from "@/app/actions/runbook";
import { ActionForm, Submit } from "@/components/forms";
import { fmtDateTime } from "@/lib/dates";
import type { RunbookState } from "@/lib/services/runbook";

const KIND: Record<string, string> = { OPEN: "Ouvrir", CHECK: "Contrôler", DO: "Faire", COMPARE: "Comparer", CAPTURE: "Relever", STOP: "Sécurité" };

/**
 * Guide pas-à-pas d'une action manuelle (US-102). Chaque étape se coche (formulaire, sans JavaScript requis) ; l'avancement est enregistré
 * avec la personne et l'heure. Lecture seule pour qui n'a pas le droit d'exécuter.
 */
export function Runbook({ actionId, state, canCheck }: { actionId: string; state: RunbookState; canCheck: boolean }) {
  const { progress } = state;
  return (
    <div data-testid="runbook">
      <p className="runbook-progress" data-testid="runbook-progress" role="status">
        {progress.done} étape{progress.done > 1 ? "s" : ""} cochée{progress.done > 1 ? "s" : ""} sur {progress.total}{progress.blocked ? ". Guide bloqué : lisez la consigne d'arrêt avant toute chose." : progress.complete ? " : guide terminé, vous pouvez déclarer la réalisation." : "."}
      </p>
      <progress className="runbook-bar" max={progress.total} value={progress.done} aria-label="Avancement du guide" />
      <ol className="runbook-steps" role="list">
        {state.steps.map((s, n) => (
          <li key={s.id} className={`runbook-step${s.done ? " is-done" : ""}${s.kind === "STOP" ? " is-stop" : ""}`} data-testid="runbook-step" data-step={s.id} data-done={s.done ? "true" : "false"}>
            <div className="runbook-text">
              <span className="runbook-kind"><span className="sr-only">Étape {n + 1} : </span>{KIND[s.kind]}</span>
              <p className="runbook-title">{s.title}</p>
              {s.detail && <p className="runbook-detail">{s.detail}</p>}
              {s.done && <p className="runbook-done">Faite par {s.done.by}, le {fmtDateTime(s.done.at)}.</p>}
            </div>
            {s.checkable && canCheck && (
              <ActionForm action={toggleRunbookStepAction} hidden={{ actionId, stepId: s.id, done: s.done ? 0 : 1 }} className="runbook-form">
                <Submit className={s.done ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"} icon={s.done ? undefined : "check"} ariaLabel={`${s.done ? "Annuler" : "Marquer comme faite"} : ${s.title}`}>{s.done ? "Annuler" : "Marquer comme faite"}</Submit>
              </ActionForm>
            )}
            {s.checkable && !canCheck && <span className="runbook-state">{s.done ? "Faite" : "À faire"}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

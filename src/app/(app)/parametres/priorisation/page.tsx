import { saveScoringAction } from "@/app/actions/settings";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { requireUser } from "@/lib/auth";
import { IMPLEMENTED_PLAYBOOKS, PLAYBOOKS } from "@/lib/engine/playbooks";
import { EXECUTION_MODES, MODE_LABEL, RISK_LABEL, RISKS, resolveScoring, SCORING_LIMITS } from "@/lib/engine/scoring";
import { RightsNotice } from "@/components/Rights";

export const metadata = { title: "Priorisation des dossiers" };
export default async function Priorisation() {
  const user = await requireUser();
  const scoring = resolveScoring(user.settings.scoring);
  return (
    <Page title="Priorisation des dossiers" sub="Le classement de la file des opportunités" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "Priorisation des dossiers" }]}>
      <section className="section" id="priorisation" data-testid="priorisation" style={{ marginTop: 0 }}>
        <div className="page-head"><h1>Priorisation des dossiers</h1></div>
        <RightsNotice need="workspace.manage" />
        <p className="section-note">Les dossiers sont classés par : gain net attendu × confiance × urgence × poids du playbook − coût d'exécution − pénalité de risque. Ce classement organise le travail ; il ne contourne jamais un veto ni une approbation, et les dossiers sous veto restent en tête.</p>
        <p className="section-note">Laissez les valeurs par défaut tant que vous n'avez pas de raison de les changer (poids : 1 = neutre). Saisissez les décimales avec un point.</p>
        <ActionForm need="workspace.manage" action={saveScoringAction} resetOnField="retablir">
          <h2 className="sub">Poids par playbook</h2>
          <div className="form-grid">
            {IMPLEMENTED_PLAYBOOKS.map((c) => (
              <div className="field" key={c}>
                <label htmlFor={"w-" + c}>{c} · {PLAYBOOKS[c].label}</label>
                <input id={"w-" + c} name={"w-" + c} type="number" inputMode="decimal" step="0.1" min={SCORING_LIMITS.weight.min} max={SCORING_LIMITS.weight.max} defaultValue={scoring.strategicWeight[c]} />
              </div>
            ))}
          </div>
          <h2 className="sub">Pénalité selon le risque (points)</h2>
          <div className="form-grid">
            {RISKS.map((r) => (
              <div className="field" key={r}>
                <label htmlFor={"r-" + r}>Risque {RISK_LABEL[r]}</label>
                <input id={"r-" + r} name={"r-" + r} type="number" inputMode="decimal" step="1" min={SCORING_LIMITS.penalty.min} max={SCORING_LIMITS.penalty.max} defaultValue={scoring.riskPenalty[r]} />
              </div>
            ))}
          </div>
          <h2 className="sub">Coût d'exécution (euros)</h2>
          <div className="form-grid">
            {EXECUTION_MODES.filter((m) => m !== "NONE").map((m) => (
              <div className="field" key={m}>
                <label htmlFor={"c-" + m}>{MODE_LABEL[m][0].toUpperCase() + MODE_LABEL[m].slice(1)}</label>
                <input id={"c-" + m} name={"c-" + m} type="number" inputMode="decimal" step="1" min={SCORING_LIMITS.cost.min} max={SCORING_LIMITS.cost.max} defaultValue={scoring.executionCost[m]} />
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <Submit icon="check" pendingLabel="Enregistrement…">Enregistrer la priorisation</Submit>
            {/* surtout pas name="reset" : un champ de ce nom masque form.reset(), que React appelle après l'action (erreur et messages dupliqués) */}
            <button type="submit" name="retablir" value="1" className="btn" formNoValidate>Rétablir les valeurs par défaut</button>
          </div>
        </ActionForm>
      </section>
    </Page>
  );
}

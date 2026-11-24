"use client";
import { draftReportAction, saveReportAction } from "@/app/actions/reports";
import { ActionForm, Submit } from "@/components/forms";

/**
 * Brouillon d'un rapport (US-112) : texte retouchable, actualisation des chiffres, certification.
 * Un seul formulaire porte le texte pour « Enregistrer » comme pour « Certifier » : ce qui est certifié est exactement ce qui est affiché.
 * Le serveur refuse tout nombre absent des métriques : l'erreur revient sous le champ.
 */
export function ReportEditor({ reportId, propertyId, month, narrative, edited, max, readOn }: { reportId: string; propertyId: string; month: string; narrative: string; edited: boolean; max: number; readOn: string }) {
  return (
    <div className="report-editor" data-testid="rapport-editeur">
      <ActionForm action={saveReportAction} hidden={{ reportId }}>
        <div className="field">
          <label htmlFor="rapport-texte">Texte du rapport</label>
          <textarea id="rapport-texte" name="narrative" rows={14} maxLength={max} required defaultValue={narrative} />
          <span className="help">Chaque nombre du texte doit figurer dans les métriques ci-dessus ; les mentions « Contribution non calculée », « Écart à l'objectif inconnu » et, quand elles s'appliquent, celles du net partiel et de l'absence d'effet attribué doivent rester. Paragraphes séparés par une ligne vide.</span>
        </div>
        <div className="field">
          <label className="check"><input type="checkbox" name="confirm" value="1" /> J'ai relu les chiffres (lus le {readOn}) et ce texte : je certifie ce rapport, ce qui est définitif.</label>
        </div>
        <div className="btn-row report-actions">
          <Submit className="btn btn-secondary" pendingLabel="Enregistrement…" name="intent" value="save">Enregistrer le texte</Submit>
          <Submit className="btn btn-primary" pendingLabel="Certification…" name="intent" value="certify">Certifier le rapport</Submit>
        </div>
      </ActionForm>
      <div className="btn-row report-actions">
        <ActionForm action={draftReportAction} hidden={{ propertyId, month, replaceEdits: edited ? "1" : "0" }}>
          <Submit className="btn btn-ghost" pendingLabel="Mise à jour…">{edited ? "Régénérer (efface mes retouches)" : "Actualiser les chiffres"}</Submit>
        </ActionForm>
      </div>
      <p className="muted report-note">Certifier fige le texte et les chiffres : aucune modification ensuite, une correction ouvre une nouvelle version.</p>
    </div>
  );
}

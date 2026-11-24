"use client";
import { draftReportAction } from "@/app/actions/reports";
import { ActionForm, Submit } from "@/components/forms";

/** Prépare le rapport d'un mois terminé (US-112) ; ouvre une nouvelle version quand la dernière est certifiée. */
export function ReportStart({ propertyId, months, label }: { propertyId: string; months: { value: string; label: string }[]; label: string }) {
  return (
    <ActionForm action={draftReportAction} hidden={{ propertyId }} className="report-start">
      <div className="field">
        <label htmlFor="rapport-mois">Mois à rapporter</label>
        <select id="rapport-mois" name="month" defaultValue={months[0]?.value}>{months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
      </div>
      <div className="btn-row"><Submit className="btn btn-primary" pendingLabel="Préparation…">{label}</Submit></div>
    </ActionForm>
  );
}

import { confirmMappingAction } from "@/app/actions/mapping";
import { ActionForm, Submit } from "./forms";

/** Confirmation du mapping : en cas d'écarts détectés, la personne déclare les avoir vérifiés. */
export function MappingConfirmForm({ propertyId, hasChecks, label }: { propertyId: string; hasChecks: boolean; label: string }) {
  return (
    <ActionForm action={confirmMappingAction} hidden={{ propertyId }}>
      {hasChecks && (
        <div className="field">
          <label className="pick" style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, cursor: "pointer" }}><input type="checkbox" name="acknowledge" style={{ width: 18, height: 18, accentColor: "var(--blue-core)" }} />J'ai vérifié ces écarts : ce sont bien les bonnes annonces</label>
        </div>
      )}
      <div className="row-wrap" style={{ marginTop: 16 }}><Submit icon="check" pendingLabel="Confirmation…">{label}</Submit></div>
    </ActionForm>
  );
}

import { deletePropertyAction } from "@/app/actions/portfolio";
import { ActionForm, Submit } from "./forms";

/** Suppression définitive : le nom du logement doit être ressaisi. */
export function DeletePropertyForm({ propertyId, name }: { propertyId: string; name: string }) {
  return (
    <ActionForm action={deletePropertyAction} hidden={{ propertyId }}>
      <div className="field">
        <label htmlFor="confirmName">Pour confirmer, saisissez le nom du logement : <strong>{name}</strong></label>
        <input id="confirmName" name="confirmName" type="text" required autoComplete="off" autoCapitalize="off" spellCheck={false} />
      </div>
      <div className="row-wrap" style={{ marginTop: 16 }}><Submit className="btn btn-danger" icon="cross" pendingLabel="Suppression…">Supprimer définitivement</Submit></div>
    </ActionForm>
  );
}

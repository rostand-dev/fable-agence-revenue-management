import Link from "next/link";
import { createOwnerAction, deleteOwnerAction, updateOwnerAction } from "@/app/actions/portfolio";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { State } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listOwners } from "@/lib/services/portfolio";
import { RightsNotice } from "@/components/Rights";

export const metadata = { title: "Propriétaires" };

type O = { name?: string; email?: string | null; notes?: string | null };
function OwnerFields({ o, prefix }: { o?: O; prefix: string }) {
  return (
    <div className="form-grid">
      <div className="field"><label htmlFor={prefix + "-name"}>Nom ou société<span className="req" aria-hidden="true">*</span></label><input id={prefix + "-name"} name="name" type="text" required maxLength={80} defaultValue={o?.name ?? ""} autoComplete="off" /></div>
      <div className="field"><label htmlFor={prefix + "-email"}>Adresse e-mail</label><input id={prefix + "-email"} name="email" type="email" maxLength={120} defaultValue={o?.email ?? ""} placeholder="facultatif" autoComplete="off" /></div>
      <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor={prefix + "-notes"}>Notes</label><textarea id={prefix + "-notes"} name="notes" className="note" maxLength={500} defaultValue={o?.notes ?? ""} placeholder="facultatif : mandat, interlocuteur, particularités" /></div>
    </div>
  );
}

export default async function Proprietaires() {
  const user = await requireUser();
  const owners = await listOwners(user.tenantId);
  return (
    <Page title="Propriétaires" sub={`${owners.length} propriétaire${owners.length > 1 ? "s" : ""}`} crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "Propriétaires" }]}>
      <div className="page-head">
        <h1>Propriétaires</h1>
        <p>Chaque logement appartient à un propriétaire : vous, une société, ou un client dont vous gérez le bien. Le propriétaire par défaut reçoit les logements créés sans choix.</p>
      </div>
      <RightsNotice need="property.manage" />
      <div className="stack" data-testid="owners-list">
        {owners.map((o) => (
          <details className="fold" key={o.id} data-testid="owner-card">
            <summary>
              <span>{o.name}</span>
              {o.isDefault && <State role="neutre">par défaut</State>}
              <span className="muted" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{o.propertyCount} logement{o.propertyCount > 1 ? "s" : ""}</span>
            </summary>
            <div className="fold-body">
              <ActionForm need="property.manage" action={updateOwnerAction} hidden={{ ownerId: o.id }}>
                <OwnerFields o={o} prefix={"o-" + o.id} />
                <div className="row-wrap" style={{ marginTop: 16 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer</Submit></div>
              </ActionForm>
              {o.isDefault ? (
                <p className="muted" style={{ margin: "14px 0 0" }}>Le propriétaire par défaut ne peut pas être supprimé ; vous pouvez le renommer.</p>
              ) : o.propertyCount > 0 ? (
                <p className="muted" style={{ margin: "14px 0 0" }}>Ce propriétaire possède {o.propertyCount} logement{o.propertyCount > 1 ? "s" : ""} : changez leur propriétaire (Modifier le dossier) avant de le supprimer.</p>
              ) : (
                <ActionForm need="property.manage" action={deleteOwnerAction} hidden={{ ownerId: o.id }} style={{ marginTop: 14 }}><Submit className="btn btn-danger btn-sm" icon="cross" pendingLabel="Suppression…">Supprimer ce propriétaire</Submit></ActionForm>
              )}
            </div>
          </details>
        ))}
      </div>
      <section className="section">
        <h2>Ajouter un propriétaire</h2>
        <p className="section-note">Seul le nom est nécessaire. Vous pourrez ensuite rattacher des logements à ce propriétaire depuis « Modifier le dossier » ou à la création.</p>
        <ActionForm need="property.manage" action={createOwnerAction} resetOnOk>
          <OwnerFields prefix="new" />
          <div className="row-wrap" style={{ marginTop: 16 }}><Submit icon="plus" pendingLabel="Ajout…">Ajouter le propriétaire</Submit></div>
        </ActionForm>
      </section>
      <p className="muted"><Link href="/logements">Retour aux logements</Link></p>
    </Page>
  );
}

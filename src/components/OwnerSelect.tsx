/** Choix du propriétaire d'un logement. Un seul propriétaire dans l'espace : rien à choisir, le champ n'est pas affiché. */
export function OwnerSelect({ owners, value, id = "ownerId" }: { owners: { id: string; name: string; isDefault: boolean }[]; value?: string | null; id?: string }) {
  if (owners.length < 2) return null;
  const current = value && owners.some((o) => o.id === value) ? value : owners.find((o) => o.isDefault)?.id ?? owners[0].id;
  return (
    <div className="field" style={{ gridColumn: "1 / -1" }}>
      <label htmlFor={id}>Propriétaire du bien</label>
      <select id={id} name="ownerId" defaultValue={current}>
        {owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.isDefault ? " (par défaut)" : ""}</option>)}
      </select>
      <span className="help">La personne ou la société qui possède le logement. Elle se gère dans Propriétaires.</span>
    </div>
  );
}

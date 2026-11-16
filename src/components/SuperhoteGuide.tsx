/** Guide court : où créer le jeton API dans SuperHote. Repris à l'onboarding et dans l'onglet SuperHote du logement. */
export function SuperhoteGuide({ open = false }: { open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary>Où trouver mon jeton API SuperHote ? (2 minutes)</summary>
      <div className="fold-body">
        <ol className="runbook">
          <li>Dans SuperHote, ouvrez <strong>Plateformes → API</strong> et créez un jeton.</li>
          <li>Cochez uniquement les droits de <strong>lecture</strong> : <code>rentals.read</code>, <code>calendar.read</code> et <code>reservations.read</code>.</li>
          <li>Copiez le jeton tout de suite : SuperHote ne l'affiche qu'une seule fois. Collez-le dans le champ ci-dessus.</li>
        </ol>
        <ul className="muted" style={{ margin: "12px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
          <li><strong>Lecture seule</strong> : NuitSignal lit les réservations et le calendrier. Rien n'est modifié dans SuperHote.</li>
          <li><strong>Confidentialité</strong> : le jeton est chiffré sur le serveur et n'est plus jamais affiché en entier. Vous pouvez le supprimer ici, ou le révoquer dans SuperHote pour le rendre inutilisable.</li>
          <li><strong>Rattachement</strong> : le jeton donne accès à tous les logements du compte. Vous confirmez toujours celui qui correspond à ce logement, et un logement SuperHote ne peut alimenter qu'un seul logement.</li>
        </ul>
      </div>
    </details>
  );
}

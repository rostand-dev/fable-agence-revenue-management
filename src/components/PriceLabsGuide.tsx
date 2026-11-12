/** Guide court : où trouver la clé API dans PriceLabs. Repris à l'onboarding et dans l'onglet PriceLabs du logement. */
export function PriceLabsGuide({ open = false }: { open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary>Où trouver ma clé API PriceLabs ? (2 minutes)</summary>
      <div className="fold-body">
        <ol className="runbook">
          <li>Connectez-vous à PriceLabs, puis ouvrez <strong>Account Settings</strong> (menu de votre compte, en haut à droite).</li>
          <li>Cliquez sur <strong>API Details</strong>.</li>
          <li>Cliquez sur <strong>Get PriceLabs API Key</strong> pour activer l'API. Si elle est déjà active, la clé est affichée.</li>
          <li>Cliquez sur <strong>Copy API Key</strong>, puis collez la clé dans le champ ci-dessus.</li>
        </ol>
        <ul className="muted" style={{ margin: "12px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
          <li><strong>Coût côté PriceLabs</strong> : l'API est facturée 1 $ par mois et par annonce synchronisée, taxes en sus.</li>
          <li><strong>Synchronisation active</strong> : l'annonce doit avoir sa synchronisation activée dans PriceLabs, sinon aucun prix n'est fourni.</li>
          <li><strong>Lecture seule</strong> : NuitSignal lit la grille, le marché et les réservations. Rien n'est modifié dans PriceLabs.</li>
          <li><strong>Confidentialité</strong> : la clé est chiffrée sur le serveur et n'est plus jamais affichée en entier. Vous pouvez la supprimer ici, ou la régénérer dans PriceLabs pour la rendre inutilisable.</li>
          <li><strong>Rattachement</strong> : la clé donne accès à toutes les annonces du compte. Vous confirmez toujours celle qui correspond à ce logement, et une annonce ne peut alimenter qu'un seul logement.</li>
        </ul>
      </div>
    </details>
  );
}

"use client";

/**
 * Lien « Afficher quand même ». Lien simple, jamais préchargé : l'ouvrir enregistre le choix.
 * Le serveur ne reçoit pas l'ancre (`#plafond`) : elle est ajoutée au toucher, et le navigateur la conserve après la redirection.
 */
export function ForceLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return <a className={className} href={href} onClick={(e) => { if (window.location.hash) e.currentTarget.href = href + window.location.hash; }}>{children}</a>;
}

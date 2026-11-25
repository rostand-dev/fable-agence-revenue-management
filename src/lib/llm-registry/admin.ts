/**
 * Exploitant de la plateforme : seules ces adresses (variable LLM_ADMIN_EMAILS) peuvent valider un changement de prix ou lancer un test de modèle.
 * Pourquoi : prix validés et verdicts de qualification sont PARTAGÉS par tous les espaces ; un propriétaire ne doit pas pouvoir les modifier pour les autres.
 * Variable absente ou vide : personne (les prix détectés restent « à vérifier », aucun test n'est lancé). Pur.
 */
export function llmAdminEmails(env: Record<string, string | undefined> = process.env): string[] {
  return (env.LLM_ADMIN_EMAILS ?? "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}
export const isLlmAdmin = (email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean => !!email && llmAdminEmails(env).includes(email.trim().toLowerCase());
export const ADMIN_ONLY_MESSAGE = "Réservé à l'exploitant de la plateforme : ce réglage est partagé par tous les comptes (adresses listées dans LLM_ADMIN_EMAILS).";

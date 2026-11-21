/**
 * Catalogue des événements du journal d'audit (US-012, blueprint §12.4 et §13.1).
 *
 * Module pur (aucun accès base) : il dit QUELS événements existent, dans quelle famille, avec quel libellé.
 * Un événement absent d'ici ne peut pas être enregistré proprement : `recordAudit` le refuse en test, le signale en production.
 */
import { isTravellerKey } from "../privacy/pii";

export type AuditCategory = "APPROVAL" | "EXECUTION" | "CONFIGURATION" | "INTEGRATION" | "ACCESS" | "SYSTEM";

export const AUDIT_CATEGORIES: Record<AuditCategory, { label: string; hint: string }> = {
  APPROVAL: { label: "Décisions", hint: "Approbations, rejets, reports, inactions" },
  EXECUTION: { label: "Exécutions", hint: "Exécution, vérification, retour arrière, mesure" },
  CONFIGURATION: { label: "Réglages", hint: "Logements, coûts, équipe, modèles, fonctionnalités" },
  INTEGRATION: { label: "Intégrations", hint: "PriceLabs, SuperHote, coupe-circuit" },
  ACCESS: { label: "Accès", hint: "Création de compte, connexion, mot de passe" },
  SYSTEM: { label: "Système", hint: "Revues, démonstration, relectures" },
};
export const AUDIT_CATEGORY_ORDER: AuditCategory[] = ["APPROVAL", "EXECUTION", "CONFIGURATION", "INTEGRATION", "ACCESS", "SYSTEM"];

/** type → famille et libellé court (affiché dans le journal à la place du code technique) */
export const AUDIT_TYPES = {
  // décisions et approbations
  "action.approved": { category: "APPROVAL", label: "Action approuvée" },
  "opportunity.rejected": { category: "APPROVAL", label: "Proposition rejetée" },
  "opportunity.no_action": { category: "APPROVAL", label: "Inaction retenue" },
  "opportunity.deferred": { category: "APPROVAL", label: "Dossier différé" },
  "opportunity.reopened": { category: "APPROVAL", label: "Dossier rouvert" },
  // exécution et mesure
  "action.executed": { category: "EXECUTION", label: "Action exécutée" },
  "action.failed": { category: "EXECUTION", label: "Exécution en échec" },
  "action.verified": { category: "EXECUTION", label: "Action vérifiée" },
  "action.verification_failed": { category: "EXECUTION", label: "Vérification en échec" },
  "action.rolled_back": { category: "EXECUTION", label: "Retour arrière" },
  "experiment.measured": { category: "EXECUTION", label: "Résultat mesuré" },
  // réglages
  "property.created": { category: "CONFIGURATION", label: "Logement créé" },
  "property.draft_saved": { category: "CONFIGURATION", label: "Saisie enregistrée" },
  "property.updated": { category: "CONFIGURATION", label: "Logement modifié" },
  "property.rules_saved": { category: "CONFIGURATION", label: "Règles de vente enregistrées" },
  "property.economics_versioned": { category: "CONFIGURATION", label: "Version du modèle économique enregistrée" },
  "property.costs_validated": { category: "CONFIGURATION", label: "Coûts et seuils validés" },
  "property.strategy_synced": { category: "CONFIGURATION", label: "Stratégie relue depuis PriceLabs" },
  "property.launched": { category: "CONFIGURATION", label: "Observation lancée" },
  "property.activated": { category: "CONFIGURATION", label: "Logement activé" },
  "property.floors_validated": { category: "CONFIGURATION", label: "Planchers validés" },
  "property.reconciliation_recorded": { category: "CONFIGURATION", label: "Rapprochement de réservations attesté" },
  "property.deleted": { category: "CONFIGURATION", label: "Logement supprimé" },
  "owner.created": { category: "CONFIGURATION", label: "Propriétaire créé" },
  "owner.updated": { category: "CONFIGURATION", label: "Propriétaire modifié" },
  "owner.deleted": { category: "CONFIGURATION", label: "Propriétaire supprimé" },
  "listing.created": { category: "CONFIGURATION", label: "Annonce créée" },
  "listing.updated": { category: "CONFIGURATION", label: "Annonce modifiée" },
  "listing.archived": { category: "CONFIGURATION", label: "Annonce archivée" },
  "listing.restored": { category: "CONFIGURATION", label: "Annonce rétablie" },
  "listing.deleted": { category: "CONFIGURATION", label: "Annonce supprimée" },
  "mapping.confirmed": { category: "CONFIGURATION", label: "Mapping des identifiants confirmé" },
  "strategy.draft_saved": { category: "CONFIGURATION", label: "Brouillon de stratégie enregistré" },
  "strategy.draft_discarded": { category: "CONFIGURATION", label: "Brouillon de stratégie abandonné" },
  "strategy.published": { category: "CONFIGURATION", label: "Stratégie publiée" },
  "strategy.rolled_back": { category: "CONFIGURATION", label: "Stratégie restaurée" },
  "tenant.renamed": { category: "CONFIGURATION", label: "Espace renommé" },
  "flag.changed": { category: "CONFIGURATION", label: "Fonction activée ou désactivée" },
  "settings.agents_renamed": { category: "CONFIGURATION", label: "Prénoms de l'équipe modifiés" },
  "llm.key_saved": { category: "CONFIGURATION", label: "Clé Anthropic enregistrée" },
  "llm.key_removed": { category: "CONFIGURATION", label: "Clé Anthropic supprimée" },
  "llm.models_saved": { category: "CONFIGURATION", label: "Modèles par agent enregistrés" },
  "llm.model_saved": { category: "CONFIGURATION", label: "Modèle d'un agent modifié" },
  "llm.models_refreshed": { category: "CONFIGURATION", label: "Liste des modèles actualisée" },
  // intégrations
  "integration.kill_switch_on": { category: "INTEGRATION", label: "Coupe-circuit activé" },
  "integration.kill_switch_off": { category: "INTEGRATION", label: "Coupe-circuit levé" },
  "integration.pricelabs_connected": { category: "INTEGRATION", label: "PriceLabs connecté" },
  "integration.pricelabs_listing_linked": { category: "INTEGRATION", label: "Annonce PriceLabs rattachée" },
  "integration.pricelabs_listing_unlinked": { category: "INTEGRATION", label: "Annonce PriceLabs détachée" },
  "integration.pricelabs_tested": { category: "INTEGRATION", label: "Connexion PriceLabs testée" },
  "integration.pricelabs_listing_changed": { category: "INTEGRATION", label: "Annonce PriceLabs modifiée chez PriceLabs" },
  "integration.pricelabs_config_changed": { category: "INTEGRATION", label: "Configuration PriceLabs modifiée chez PriceLabs" },
  "integration.pricelabs_disconnected": { category: "INTEGRATION", label: "PriceLabs déconnecté" },
  "integration.superhote_connected": { category: "INTEGRATION", label: "SuperHote connecté" },
  "integration.superhote_rental_linked": { category: "INTEGRATION", label: "Logement SuperHote rattaché" },
  "integration.superhote_rental_unlinked": { category: "INTEGRATION", label: "Logement SuperHote détaché" },
  "integration.superhote_disconnected": { category: "INTEGRATION", label: "SuperHote déconnecté" },
  "integration.superhote_webhook_registered": { category: "INTEGRATION", label: "Webhooks SuperHote activés" },
  "integration.superhote_webhook_removed": { category: "INTEGRATION", label: "Webhooks SuperHote supprimés" },
  "integration.webhook_replayed": { category: "INTEGRATION", label: "Livraison SuperHote rejouée" },
  "integration.webhook_dismissed": { category: "INTEGRATION", label: "Livraison SuperHote écartée" },
  "reservations.channel_overrides": { category: "INTEGRATION", label: "Canaux de réservations précisés" },
  // accès
  "account.created": { category: "ACCESS", label: "Compte créé" },
  "account.login": { category: "ACCESS", label: "Connexion" },
  "account.password_changed": { category: "ACCESS", label: "Mot de passe modifié" },
  "account.login_remembered": { category: "ACCESS", label: "Connexion automatique (appareil reconnu)" },
  "account.logout_everywhere": { category: "ACCESS", label: "Déconnexion de tous les appareils" },
  // système
  "review.completed": { category: "SYSTEM", label: "Revue terminée" },
  "demo.seeded": { category: "SYSTEM", label: "Démonstration installée" },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;

export type AuditType = keyof typeof AUDIT_TYPES;
export const isAuditType = (v: string): v is AuditType => Object.prototype.hasOwnProperty.call(AUDIT_TYPES, v);
/** Libellé lisible ; un type inconnu (ancien événement) reste affiché tel quel plutôt que masqué. */
export const auditLabel = (type: string): string => (isAuditType(type) ? AUDIT_TYPES[type].label : type);
export const auditCategoryOf = (type: string): AuditCategory => (isAuditType(type) ? AUDIT_TYPES[type].category : "SYSTEM");
export const typesOfCategory = (c: AuditCategory): AuditType[] => (Object.keys(AUDIT_TYPES) as AuditType[]).filter((t) => AUDIT_TYPES[t].category === c);
export const isAuditCategory = (v: unknown): v is AuditCategory => typeof v === "string" && Object.prototype.hasOwnProperty.call(AUDIT_CATEGORIES, v);

/** Auteur d'un événement : `user:<id>`, `agent:<id>`, `system` ou `demo`. */
export const userActor = (userId: string) => "user:" + userId;
export const agentActor = (agentId: string) => "agent:" + agentId;

/** Ce qui ne doit jamais entrer dans le journal : secrets, jetons, mots de passe. Les valeurs sont masquées, la clé reste visible. */
const SECRET_KEY = /(secret|token|jeton|password|passwd|mot_?de_?passe|api_?key|apikey|key_?enc|authorization|cookie|private_?key|credential|bearer|pwd|otp|passphrase)/i;
export const MASKED = "[masqué]";
export function redactPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return MASKED;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1));
  // US-034 : l'identité d'un voyageur (nom, e-mail, téléphone, notes privées…) n'entre jamais dans le journal
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) || isTravellerKey(k) ? MASKED : redactPayload(v, depth + 1)]));
}

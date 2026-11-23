/**
 * Rôles et droits (US-084, blueprint §2.2 RACI et §16.1).
 *
 * Module pur, sans accès base : il dit QUI peut faire QUOI dans le circuit de décision. Le serveur applique ces droits
 * (services de décision, API) ; les écrans ne font que masquer ce que le serveur refuserait de toute façon.
 *
 * Périmètre de l'épic 8 : le circuit de décision (approuver, rejeter, différer, rouvrir, exécuter, vérifier, revenir en arrière)
 * et la lecture du journal d'audit. Les réglages (coûts, clés, intégrations) ne sont pas encore soumis aux rôles.
 */
export const ROLES = ["OWNER", "TENANT_ADMIN", "REVENUE_MANAGER", "ANALYST", "OTA_OPERATOR", "OWNER_VIEWER", "AUDITOR"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Propriétaire du compte",
  TENANT_ADMIN: "Administrateur",
  REVENUE_MANAGER: "Revenue manager",
  ANALYST: "Analyste",
  OTA_OPERATOR: "Opérateur OTA",
  OWNER_VIEWER: "Propriétaire du bien (lecture)",
  AUDITOR: "Auditeur",
};
export const ROLE_SUMMARY: Record<Role, string> = {
  OWNER: "Crée le compte : tous les droits de décision, comme avant l'arrivée des rôles.",
  TENANT_ADMIN: "Tous les droits de décision et la lecture du journal d'audit.",
  REVENUE_MANAGER: "Arbitre les dossiers, supervise l'exécution et peut revenir en arrière.",
  ANALYST: "Lit les dossiers, les analyses et les preuves ; ne décide rien.",
  OTA_OPERATOR: "Applique et prouve les procédures manuelles sur les canaux, puis les relit ; ne décide pas.",
  OWNER_VIEWER: "Suit la performance et les décisions du bien, en lecture seule.",
  AUDITOR: "Lit les dossiers et le journal d'audit, sans pouvoir rien modifier.",
};

export const PERMISSIONS = ["decision.decide", "action.execute.api", "action.execute.manual", "action.verify", "action.rollback", "audit.read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABEL: Record<Permission, string> = {
  "decision.decide": "Approuver, rejeter, différer ou rouvrir un dossier",
  "action.execute.api": "Exécuter une action par écriture PriceLabs ou tâche interne",
  "action.execute.manual": "Appliquer une procédure manuelle sur un canal et la déclarer",
  "action.verify": "Vérifier une action exécutée",
  "action.rollback": "Lancer un retour arrière",
  "audit.read": "Lire le journal d'audit",
};
/** Verbe de refus, à la forme infinitive : « votre rôle ne permet pas de … ». */
const DENY_VERB: Record<Permission, string> = {
  "decision.decide": "décider d'un dossier (approuver, rejeter, différer ou rouvrir)",
  "action.execute.api": "exécuter une action par écriture PriceLabs ou tâche interne",
  "action.execute.manual": "appliquer une procédure manuelle",
  "action.verify": "vérifier une action exécutée",
  "action.rollback": "lancer un retour arrière",
  "audit.read": "lire le journal d'audit",
};

const FULL: readonly Permission[] = PERMISSIONS;
/** Matrice des droits : une ligne par rôle, aucune exception ailleurs dans le code. */
export const GRANTS: Record<Role, readonly Permission[]> = {
  OWNER: FULL,
  TENANT_ADMIN: FULL,
  REVENUE_MANAGER: FULL,
  ANALYST: [],
  OTA_OPERATOR: ["action.execute.manual", "action.verify"],
  OWNER_VIEWER: [],
  AUDITOR: ["audit.read"],
};

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
/** Une valeur inconnue en base ne donne jamais de droit : elle est lue comme « lecture seule ». */
export const normalizeRole = (raw: unknown): Role => (isRole(raw) ? raw : "OWNER_VIEWER");

export const can = (role: Role, permission: Permission): boolean => GRANTS[role].includes(permission);

/** Mode d'exécution d'une action (voir `executionMode` des options) → droit requis. */
export const executePermission = (mode: string | null | undefined): Permission => (mode === "MANUAL_RUNBOOK" ? "action.execute.manual" : "action.execute.api");

export const denyMessage = (role: Role, permission: Permission): string => `Votre rôle (${ROLE_LABEL[role]}) ne permet pas de ${DENY_VERB[permission]}.`;

/** Rôles qui possèdent un droit, pour dire à qui s'adresser. */
export const rolesWith = (permission: Permission): Role[] => ROLES.filter((r) => can(r, permission));

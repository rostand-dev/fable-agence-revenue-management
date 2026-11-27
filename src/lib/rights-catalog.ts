import type { Permission } from "@/lib/rbac";

/**
 * Qui peut écrire quoi. Chaque action serveur (`src/app/actions/*.ts`) et chaque route qui modifie quelque chose figure ici :
 *  - `permission` : contrôlé à l'entrée (lib/rights.ts) ; le formulaire correspondant porte `need="…"` ;
 *  - `service` : contrôlé par le service appelé, qui connaît le dossier visé (droit selon le cas) ;
 *  - `open` : ouvert à tout compte, avec la raison.
 * Les tests échouent si une écriture n'est pas déclarée ou si un rôle sans droit passe (rights.test.ts, rights.db.test.ts).
 */
export type Right = { permission: Permission } | { service: string } | { open: string };

const property = { permission: "property.manage" } as const;
const workspace = { permission: "workspace.manage" } as const;
const own = { open: "Ne touche qu'au compte ou à la session de la personne qui agit." } as const;
const decisions = { service: "Circuit de décision : le droit est contrôlé par lib/services/decisions.ts." } as const;
const promotions = { service: "Registre des promotions : le droit est contrôlé par lib/services/promotion-registry.ts." } as const;
const operator = { open: "Réservé à l'exploitant de la plateforme (LLM_ADMIN_EMAILS), quel que soit le rôle." } as const;

export const ACTION_RIGHTS: Record<string, Right> = {
  // actions/auth.ts
  signupAction: own, confirmSignupAction: own, loginAction: own, logoutAction: own, logoutEverywhereAction: own, requestPasswordResetAction: own, resetPasswordAction: own,
  // actions/costs.ts, seasons.ts
  saveCostsAction: property, saveSeasonsAction: property,
  // actions/reports.ts
  draftReportAction: { service: "Rapports mensuels : le droit est contrôlé par lib/services/reports.ts." },
  saveReportAction: { service: "Rapports mensuels : le droit est contrôlé par lib/services/reports.ts." },
  // actions/promotions.ts, runbook.ts
  declarePromotionAction: promotions, updatePromotionAction: promotions, endPromotionAction: promotions, verifyPromotionAction: promotions,
  toggleRunbookStepAction: { service: "Guide pas-à-pas : le droit est contrôlé par lib/services/runbook.ts." },
  // actions/decisions.ts
  approveAction: decisions, rejectAction: decisions, deferAction: decisions, reopenAction: decisions, executeAction: decisions, verifyAction: decisions,
  rollbackAction: decisions, acknowledgeAlertAction: decisions, interruptStuckAction: decisions, reviewAction: decisions,
  resetDemoAction: workspace,
  chatAction: { open: "Question posée à un agent : consultation, aucune décision ni réglage n'est modifié." },
  // actions/llm.ts
  saveLlmKeyAction: workspace, removeLlmKeyAction: workspace, refreshModelsAction: workspace, saveAgentModelsAction: workspace, saveAgentModelAction: workspace, saveMonthlyCapAction: workspace,
  decidePriceAction: operator, benchModelAction: operator,
  // actions/onboarding.ts
  saveLogementAction: property, saveReglesAction: property, stepAction: property, funnelSelectRentalAction: property, funnelSelectListingAction: property, launchAction: property,
  // actions/pricelabs.ts
  connectPriceLabsAction: property, selectListingAction: property, detachListingAction: property, syncPriceLabsAction: property, testPriceLabsAction: property, disconnectPriceLabsAction: property, channelOverridesAction: property,
  // actions/settings.ts
  updatePropertyAction: property, renameAgentsAction: workspace, saveScoringAction: workspace, setFlagAction: property, killSwitchAction: property,
  // actions/portfolio.ts
  createOwnerAction: property, updateOwnerAction: property, deleteOwnerAction: property, saveListingAction: property, setListingStatusAction: property, deleteListingAction: property,
  deletePropertyAction: { service: "Suppression d'un logement : le droit `property.delete` est contrôlé par lib/services/portfolio.ts." },
  renameTenantAction: workspace,
  // actions/strategy.ts, quality.ts, validations.ts, mapping.ts
  saveStrategyDraftAction: property, discardStrategyDraftAction: property, publishStrategyAction: property, rollbackStrategyAction: property,
  activatePropertyAction: property, validateFloorsAction: property, recordReconciliationAction: property, confirmMappingAction: property,
  // actions/superhote.ts, ingestion.ts
  connectSuperhoteAction: property, selectRentalAction: property, detachRentalAction: property, syncSuperhoteAction: property, disconnectSuperhoteAction: property,
  enableWebhookAction: property, disableWebhookAction: property, replayDeliveryAction: property, replayAllDeliveriesAction: property, dismissDeliveryAction: property,
};

/** Routes d'API qui acceptent autre chose qu'une lecture, par « MÉTHODE chemin ». */
export const ROUTE_RIGHTS: Record<string, Right> = {
  "POST api/chat": { open: "Question posée à un agent : consultation, aucune décision ni réglage n'est modifié." },
  "POST api/session/end": own,
  "POST api/session/touch": own,
  "POST api/webhooks/superhote/[endpointId]": { open: "Sans session : l'authenticité vient de la signature HMAC de SuperHote." },
  "POST api/v1/opportunities/[id]/approve": decisions,
  "POST api/v1/opportunities/[id]/reject": decisions,
  "POST api/v1/owners": property,
  "PATCH api/v1/owners/[id]": property,
  "DELETE api/v1/owners/[id]": property,
  "POST api/v1/properties": property,
  "PATCH api/v1/properties/[id]": property,
  "DELETE api/v1/properties/[id]": { permission: "property.delete" },
  "POST api/v1/properties/[id]/listings": property,
  "PATCH api/v1/properties/[id]/listings/[listingId]": property,
  "DELETE api/v1/properties/[id]/listings/[listingId]": property,
  "PUT api/v1/properties/[id]/economics/seasons": property,
  "POST api/v1/properties/[id]/activate": property,
  "POST api/v1/properties/[id]/validations/floors": property,
  "POST api/v1/properties/[id]/validations/reconciliation": property,
  "POST api/v1/properties/[id]/mapping": property,
  "PUT api/v1/properties/[id]/strategy": property,
  "DELETE api/v1/properties/[id]/strategy": property,
  "POST api/v1/properties/[id]/strategy/publish": property,
  "POST api/v1/properties/[id]/strategy/rollback": property,
};

/**
 * Routes GET, par chemin : « lecture », ou ce que l'appel écrit tout de même. Aucune n'exige de droit d'écriture ;
 * en déclarer une oblige à dire si elle écrit (rights-catalog.test.ts ; rights.db.test.ts le vérifie sur la base).
 * Hors sujet ici : l'entretien de la session à chaque requête authentifiée et les migrations rejouées au démarrage.
 */
export const GET_ROUTES: Record<string, "lecture" | { ecrit: string }> = {
  "api/audit-events": "lecture",
  "api/health": "lecture",
  "api/rapports/[id]/export": { ecrit: "Consigne l'export au journal d'audit." },
  "api/rapports/historique": { ecrit: "Consigne l'export au journal d'audit." },
  "api/session/restore": { ecrit: "Rouvre la session d'un appareil « Rester connecté » (jeton rotatif) et le consigne au journal." },
  "api/v1/owners": { ecrit: "Crée le propriétaire par défaut de l'espace s'il n'existe pas encore (rejouable, jamais deux)." },
  "api/v1/properties": "lecture",
  "api/v1/properties/[id]": "lecture",
  "api/v1/properties/[id]/economics/floors": "lecture",
  "api/v1/properties/[id]/economics/versions": "lecture",
  "api/v1/properties/[id]/listings": "lecture",
  "api/v1/properties/[id]/mapping": "lecture",
  "api/v1/properties/[id]/pace": "lecture",
  "api/v1/properties/[id]/performance": "lecture",
  "api/v1/properties/[id]/quality": "lecture",
  "api/v1/properties/[id]/simulate": "lecture",
  "api/v1/properties/[id]/snapshots": "lecture",
  "api/v1/properties/[id]/strategy": "lecture",
  "api/v1/properties/[id]/validations": "lecture",
  "api/v1/snapshots/[snapshotId]": "lecture",
  "demo": { ecrit: "Ouvre la session du compte de démonstration (instance de démonstration seulement), avec une limite de visites." },
  "vue": { ecrit: "Pose les cookies de préférence d'affichage (sans session) ; aucune donnée modifiée." },
};

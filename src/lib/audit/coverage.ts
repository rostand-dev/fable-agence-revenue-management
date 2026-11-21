import type { AuditType } from "./types";

/**
 * Couverture d'audit (US-012 : « audit append-only de toute mutation et approbation »).
 *
 * Chaque action serveur (`src/app/actions/*.ts`) et chaque route qui modifie quelque chose doit figurer ici, soit avec les événements
 * qu'elle inscrit au journal, soit avec la raison pour laquelle elle n'en inscrit pas. Le test `coverage.test.ts` échoue quand une
 * action est ajoutée sans être déclarée : on ne peut pas oublier le journal, on peut seulement s'en passer en le justifiant.
 */
export type Coverage = { events: AuditType[] } | { exempt: string };

export const ACTION_COVERAGE: Record<string, Coverage> = {
  // actions/auth.ts
  signupAction: { events: ["account.created"] },
  confirmSignupAction: { events: ["account.created"] },
  loginAction: { events: ["account.login"] },
  logoutEverywhereAction: { events: ["account.logout_everywhere"] },
  logoutAction: { exempt: "Ferme une session ; aucune donnée du propriétaire n'est modifiée." },
  requestPasswordResetAction: { exempt: "Crée un lien à usage unique sans changer le compte ; réponse identique que l'adresse existe ou non, donc rien à consigner par propriétaire." },
  resetPasswordAction: { events: ["account.password_changed"] },
  // actions/costs.ts
  saveCostsAction: { events: ["property.costs_validated", "property.economics_versioned"] },
  // actions/decisions.ts
  approveAction: { events: ["action.approved", "opportunity.no_action"] },
  rejectAction: { events: ["opportunity.rejected"] },
  deferAction: { events: ["opportunity.deferred"] },
  reopenAction: { events: ["opportunity.reopened"] },
  executeAction: { events: ["action.executed", "action.failed"] },
  verifyAction: { events: ["action.verified", "action.verification_failed"] },
  rollbackAction: { events: ["action.rolled_back"] },
  reviewAction: { events: ["review.completed"] },
  resetDemoAction: { events: ["demo.seeded"] },
  chatAction: { exempt: "Conversation avec un agent : aucune décision ni réglage n'est modifié, l'échange est conservé dans chat_messages." },
  // actions/llm.ts
  saveLlmKeyAction: { events: ["llm.key_saved"] },
  removeLlmKeyAction: { events: ["llm.key_removed"] },
  refreshModelsAction: { events: ["llm.models_refreshed"] },
  saveAgentModelsAction: { events: ["llm.models_saved"] },
  saveAgentModelAction: { events: ["llm.model_saved"] },
  // actions/onboarding.ts
  saveLogementAction: { events: ["property.created"] },
  saveReglesAction: { events: ["property.rules_saved"] },
  stepAction: { exempt: "Avance, reporte ou quitte une étape du parcours : seule la progression du brouillon change, pas la configuration du logement." },
  funnelSelectRentalAction: { events: ["integration.superhote_rental_linked"] },
  funnelSelectListingAction: { events: ["integration.pricelabs_listing_linked"] },
  launchAction: { events: ["property.launched"] },
  // actions/pricelabs.ts
  connectPriceLabsAction: { events: ["integration.pricelabs_connected"] },
  selectListingAction: { events: ["integration.pricelabs_listing_linked"] },
  detachListingAction: { events: ["integration.pricelabs_listing_unlinked"] },
  syncPriceLabsAction: { events: ["property.strategy_synced", "integration.pricelabs_listing_changed"] },
  testPriceLabsAction: { events: ["integration.pricelabs_tested"] },
  disconnectPriceLabsAction: { events: ["integration.pricelabs_disconnected"] },
  channelOverridesAction: { events: ["reservations.channel_overrides"] },
  // actions/settings.ts
  updatePropertyAction: { events: ["property.updated", "property.draft_saved"] },
  renameAgentsAction: { events: ["settings.agents_renamed"] },
  setFlagAction: { events: ["flag.changed"] },
  killSwitchAction: { events: ["integration.kill_switch_on", "integration.kill_switch_off"] },
  // actions/portfolio.ts (US-020)
  createOwnerAction: { events: ["owner.created"] },
  updateOwnerAction: { events: ["owner.updated"] },
  deleteOwnerAction: { events: ["owner.deleted"] },
  saveListingAction: { events: ["listing.created", "listing.updated"] },
  setListingStatusAction: { events: ["listing.archived", "listing.restored"] },
  deleteListingAction: { events: ["listing.deleted"] },
  deletePropertyAction: { events: ["property.deleted"] },
  renameTenantAction: { events: ["tenant.renamed"] },
  // actions/strategy.ts (US-023)
  saveStrategyDraftAction: { events: ["strategy.draft_saved"] },
  discardStrategyDraftAction: { events: ["strategy.draft_discarded"] },
  publishStrategyAction: { events: ["strategy.published"] },
  rollbackStrategyAction: { events: ["strategy.rolled_back"] },
  // actions/quality.ts (US-024)
  activatePropertyAction: { events: ["property.activated"] },
  validateFloorsAction: { events: ["property.floors_validated"] },
  recordReconciliationAction: { events: ["property.reconciliation_recorded"] },
  // actions/mapping.ts (US-021)
  confirmMappingAction: { events: ["mapping.confirmed"] },
  // actions/superhote.ts
  connectSuperhoteAction: { events: ["integration.superhote_connected"] },
  selectRentalAction: { events: ["integration.superhote_rental_linked"] },
  detachRentalAction: { events: ["integration.superhote_rental_unlinked"] },
  syncSuperhoteAction: { exempt: "Relecture des réservations en lecture seule : les données lues remplacent les précédentes (ingestion), aucune décision ni réglage ne change." },
  disconnectSuperhoteAction: { events: ["integration.superhote_disconnected"] },
  replayDeliveryAction: { events: ["integration.webhook_replayed"] },
  replayAllDeliveriesAction: { events: ["integration.webhook_replayed"] },
  dismissDeliveryAction: { events: ["integration.webhook_dismissed"] },
  enableWebhookAction: { events: ["integration.superhote_webhook_registered"] },
  disableWebhookAction: { events: ["integration.superhote_webhook_removed"] },
};

/** Routes d'API qui acceptent autre chose qu'une lecture. */
export const ROUTE_COVERAGE: Record<string, Coverage> = {
  "api/chat": { exempt: "Conversation avec un agent (flux) : aucune décision ni réglage n'est modifié." },
  "api/webhooks/superhote/[endpointId]": { exempt: "Réception d'un événement signé de SuperHote : la trace est la boîte de réception (webhook_deliveries) et l'historique des changements de réservation (reservation_changes), tous deux en base et isolés par propriétaire." },
  "api/session/touch": { exempt: "Repousse l'échéance d'inactivité de la session ; aucune donnée métier." },
  "api/session/restore": { events: ["account.login_remembered"] },
  "api/v1/owners": { events: ["owner.created"] },
  "api/v1/owners/[id]": { events: ["owner.updated", "owner.deleted"] },
  "api/v1/properties": { events: ["property.created"] },
  "api/v1/properties/[id]": { events: ["property.updated", "property.deleted"] },
  "api/v1/properties/[id]/listings": { events: ["listing.created"] },
  "api/v1/properties/[id]/listings/[listingId]": { events: ["listing.updated", "listing.archived", "listing.restored", "listing.deleted"] },
  "api/v1/properties/[id]/activate": { events: ["property.activated"] },
  "api/v1/properties/[id]/validations/floors": { events: ["property.floors_validated"] },
  "api/v1/properties/[id]/validations/reconciliation": { events: ["property.reconciliation_recorded"] },
  "api/v1/properties/[id]/mapping": { events: ["mapping.confirmed"] },
  "api/v1/properties/[id]/strategy": { events: ["strategy.draft_saved", "strategy.draft_discarded"] },
  "api/v1/properties/[id]/strategy/publish": { events: ["strategy.published"] },
  "api/v1/properties/[id]/strategy/rollback": { events: ["strategy.rolled_back"] },
  "api/session/end": { exempt: "Ferme la session après inactivité ; aucune donnée métier." },
};

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
  saveCostsAction: { events: ["property.costs_validated", "property.economics_versioned", "access.denied"] },
  // actions/reports.ts (US-112)
  draftReportAction: { events: ["report.drafted", "report.reopened", "access.denied"] },
  saveReportAction: { events: ["report.edited", "report.certified", "access.denied"] },
  // actions/promotions.ts (US-100)
  declarePromotionAction: { events: ["promotion.declared", "access.denied"] },
  updatePromotionAction: { events: ["promotion.updated", "access.denied"] },
  endPromotionAction: { events: ["promotion.ended", "access.denied"] },
  verifyPromotionAction: { events: ["promotion.verified", "access.denied"] },
  toggleRunbookStepAction: { events: ["runbook.step_checked", "runbook.step_unchecked", "access.denied"] },
  // actions/seasons.ts
  saveSeasonsAction: { events: ["property.economics_versioned", "access.denied"] },
  // actions/decisions.ts
  approveAction: { events: ["action.approved", "opportunity.no_action", "access.denied"] },
  rejectAction: { events: ["opportunity.rejected", "access.denied"] },
  deferAction: { events: ["opportunity.deferred", "access.denied"] },
  reopenAction: { events: ["opportunity.reopened", "access.denied"] },
  executeAction: { events: ["action.executed", "action.failed", "action.precondition_failed", "action.mismatch_reported", "access.denied"] },
  verifyAction: { events: ["action.verified", "action.verification_failed", "access.denied"] },
  rollbackAction: { events: ["action.rolled_back", "action.rollback_failed", "access.denied"] },
  acknowledgeAlertAction: { events: ["alert.acknowledged", "access.denied"] },
  interruptStuckAction: { events: ["action.failed", "access.denied"] },
  reviewAction: { events: ["review.completed", "access.denied"] },
  resetDemoAction: { events: ["demo.seeded", "access.denied"] },
  chatAction: { exempt: "Conversation avec un agent : aucune décision ni réglage n'est modifié, l'échange est conservé dans chat_messages." },
  // actions/llm.ts
  saveLlmKeyAction: { events: ["llm.key_saved", "access.denied"] },
  removeLlmKeyAction: { events: ["llm.key_removed", "access.denied"] },
  refreshModelsAction: { events: ["llm.models_refreshed", "access.denied"] },
  saveAgentModelsAction: { events: ["llm.models_saved", "access.denied"] },
  saveAgentModelAction: { events: ["llm.model_saved", "access.denied"] },
  saveMonthlyCapAction: { events: ["llm.cap_saved", "access.denied"] },
  decidePriceAction: { events: ["llm.price_validated", "llm.price_rejected"] },
  benchModelAction: { events: ["llm.bench_run", "llm.bench_failed"] },
  // actions/onboarding.ts
  saveLogementAction: { events: ["property.created", "access.denied"] },
  saveReglesAction: { events: ["property.rules_saved", "access.denied"] },
  stepAction: { exempt: "Avance, reporte ou quitte une étape du parcours : seule la progression du brouillon change, pas la configuration du logement (un refus de rôle est consigné)." },
  funnelSelectRentalAction: { events: ["integration.superhote_rental_linked", "access.denied"] },
  funnelSelectListingAction: { events: ["integration.pricelabs_listing_linked", "access.denied"] },
  launchAction: { events: ["property.launched", "access.denied"] },
  // actions/pricelabs.ts
  connectPriceLabsAction: { events: ["integration.pricelabs_connected", "access.denied"] },
  selectListingAction: { events: ["integration.pricelabs_listing_linked", "access.denied"] },
  detachListingAction: { events: ["integration.pricelabs_listing_unlinked", "access.denied"] },
  syncPriceLabsAction: { events: ["property.strategy_synced", "integration.pricelabs_listing_changed", "integration.pricelabs_config_changed", "access.denied"] },
  testPriceLabsAction: { events: ["integration.pricelabs_tested", "access.denied"] },
  disconnectPriceLabsAction: { events: ["integration.pricelabs_disconnected", "access.denied"] },
  channelOverridesAction: { events: ["reservations.channel_overrides", "access.denied"] },
  // actions/settings.ts
  updatePropertyAction: { events: ["property.updated", "property.draft_saved", "access.denied"] },
  renameAgentsAction: { events: ["settings.agents_renamed", "access.denied"] },
  saveScoringAction: { events: ["settings.scoring_updated", "access.denied"] },
  setFlagAction: { events: ["flag.changed", "access.denied"] },
  killSwitchAction: { events: ["integration.kill_switch_on", "integration.kill_switch_off", "access.denied"] },
  // actions/portfolio.ts (US-020)
  createOwnerAction: { events: ["owner.created", "access.denied"] },
  updateOwnerAction: { events: ["owner.updated", "access.denied"] },
  deleteOwnerAction: { events: ["owner.deleted", "access.denied"] },
  saveListingAction: { events: ["listing.created", "listing.updated", "access.denied"] },
  setListingStatusAction: { events: ["listing.archived", "listing.restored", "access.denied"] },
  deleteListingAction: { events: ["listing.deleted", "access.denied"] },
  deletePropertyAction: { events: ["property.deleted", "access.denied"] },
  renameTenantAction: { events: ["tenant.renamed", "access.denied"] },
  // actions/strategy.ts (US-023)
  saveStrategyDraftAction: { events: ["strategy.draft_saved", "access.denied"] },
  discardStrategyDraftAction: { events: ["strategy.draft_discarded", "access.denied"] },
  publishStrategyAction: { events: ["strategy.published", "access.denied"] },
  rollbackStrategyAction: { events: ["strategy.rolled_back", "access.denied"] },
  // actions/quality.ts (US-024)
  activatePropertyAction: { events: ["property.activated", "access.denied"] },
  validateFloorsAction: { events: ["property.floors_validated", "access.denied"] },
  recordReconciliationAction: { events: ["property.reconciliation_recorded", "access.denied"] },
  // actions/mapping.ts (US-021)
  confirmMappingAction: { events: ["mapping.confirmed", "access.denied"] },
  // actions/superhote.ts
  connectSuperhoteAction: { events: ["integration.superhote_connected", "access.denied"] },
  selectRentalAction: { events: ["integration.superhote_rental_linked", "access.denied"] },
  detachRentalAction: { events: ["integration.superhote_rental_unlinked", "access.denied"] },
  syncSuperhoteAction: { exempt: "Relecture des réservations en lecture seule : les données lues remplacent les précédentes (ingestion), aucune décision ni réglage ne change (un refus de rôle est consigné)." },
  disconnectSuperhoteAction: { events: ["integration.superhote_disconnected", "access.denied"] },
  replayDeliveryAction: { events: ["integration.webhook_replayed", "access.denied"] },
  replayAllDeliveriesAction: { events: ["integration.webhook_replayed", "access.denied"] },
  dismissDeliveryAction: { events: ["integration.webhook_dismissed", "access.denied"] },
  enableWebhookAction: { events: ["integration.superhote_webhook_registered", "access.denied"] },
  disableWebhookAction: { events: ["integration.superhote_webhook_removed", "access.denied"] },
};

/** Routes d'API qui acceptent autre chose qu'une lecture. */
export const ROUTE_COVERAGE: Record<string, Coverage> = {
  "api/chat": { exempt: "Conversation avec un agent (flux) : aucune décision ni réglage n'est modifié." },
  "api/webhooks/superhote/[endpointId]": { exempt: "Réception d'un événement signé de SuperHote : la trace est la boîte de réception (webhook_deliveries) et l'historique des changements de réservation (reservation_changes), tous deux en base et isolés par propriétaire." },
  "api/session/touch": { exempt: "Repousse l'échéance d'inactivité de la session ; aucune donnée métier." },
  "api/session/restore": { events: ["account.login_remembered"] },
  "api/v1/opportunities/[id]/approve": { events: ["action.approved", "opportunity.no_action", "access.denied"] },
  "api/v1/opportunities/[id]/reject": { events: ["opportunity.rejected", "access.denied"] },
  "api/v1/owners": { events: ["owner.created", "access.denied"] },
  "api/v1/owners/[id]": { events: ["owner.updated", "owner.deleted", "access.denied"] },
  "api/v1/properties": { events: ["property.created", "access.denied"] },
  "api/v1/properties/[id]": { events: ["property.updated", "property.deleted", "access.denied"] },
  "api/v1/properties/[id]/listings": { events: ["listing.created", "access.denied"] },
  "api/v1/properties/[id]/listings/[listingId]": { events: ["listing.updated", "listing.archived", "listing.restored", "listing.deleted", "access.denied"] },
  "api/v1/properties/[id]/economics/seasons": { events: ["property.economics_versioned", "access.denied"] },
  "api/v1/properties/[id]/activate": { events: ["property.activated", "access.denied"] },
  "api/v1/properties/[id]/validations/floors": { events: ["property.floors_validated", "access.denied"] },
  "api/v1/properties/[id]/validations/reconciliation": { events: ["property.reconciliation_recorded", "access.denied"] },
  "api/v1/properties/[id]/mapping": { events: ["mapping.confirmed", "access.denied"] },
  "api/v1/properties/[id]/strategy": { events: ["strategy.draft_saved", "strategy.draft_discarded", "access.denied"] },
  "api/v1/properties/[id]/strategy/publish": { events: ["strategy.published", "access.denied"] },
  "api/v1/properties/[id]/strategy/rollback": { events: ["strategy.rolled_back", "access.denied"] },
  "api/session/end": { exempt: "Ferme la session après inactivité ; aucune donnée métier." },
};

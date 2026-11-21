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
  syncPriceLabsAction: { events: ["property.strategy_synced"] },
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
  // actions/mapping.ts (US-021)
  confirmMappingAction: { events: ["mapping.confirmed"] },
  // actions/superhote.ts
  connectSuperhoteAction: { events: ["integration.superhote_connected"] },
  selectRentalAction: { events: ["integration.superhote_rental_linked"] },
  detachRentalAction: { events: ["integration.superhote_rental_unlinked"] },
  syncSuperhoteAction: { exempt: "Relecture des réservations en lecture seule : les données lues remplacent les précédentes (ingestion), aucune décision ni réglage ne change." },
  disconnectSuperhoteAction: { events: ["integration.superhote_disconnected"] },
};

/** Routes d'API qui acceptent autre chose qu'une lecture. */
export const ROUTE_COVERAGE: Record<string, Coverage> = {
  "api/chat": { exempt: "Conversation avec un agent (flux) : aucune décision ni réglage n'est modifié." },
  "api/session/touch": { exempt: "Repousse l'échéance d'inactivité de la session ; aucune donnée métier." },
  "api/session/restore": { events: ["account.login_remembered"] },
  "api/v1/owners": { events: ["owner.created"] },
  "api/v1/owners/[id]": { events: ["owner.updated", "owner.deleted"] },
  "api/v1/properties": { events: ["property.created"] },
  "api/v1/properties/[id]": { events: ["property.updated", "property.deleted"] },
  "api/v1/properties/[id]/listings": { events: ["listing.created"] },
  "api/v1/properties/[id]/listings/[listingId]": { events: ["listing.updated", "listing.archived", "listing.restored", "listing.deleted"] },
  "api/v1/properties/[id]/mapping": { events: ["mapping.confirmed"] },
  "api/session/end": { exempt: "Ferme la session après inactivité ; aucune donnée métier." },
};

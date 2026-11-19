/**
 * Catalogue des capacités réelles des intégrations (US-002, blueprint §4.2).
 *
 * Source de vérité : ce que le CODE sait faire aujourd'hui, pas ce qu'une ligne de base de données affirme.
 * Une capacité d'écriture non développée est impossible à exécuter : le garde `checkWrite` est appelé côté API
 * (`services/decisions.ts`), la règle d'audit CAPABILITY le répercute, et l'interface désactive le bouton.
 * Module pur (aucun accès base) : testable, et sert aussi à générer `docs/capacites-integrations.md`.
 */
export type Provider = "superhote" | "pricelabs" | "booking" | "airbnb";
export const PROVIDERS: Provider[] = ["superhote", "pricelabs", "booking", "airbnb"];
export const isProvider = (v: unknown): v is Provider => typeof v === "string" && (PROVIDERS as string[]).includes(v);

export type CapabilityId =
  | "pricelabs.read" | "pricelabs.write"
  | "superhote.reconcile" | "superhote.webhooks"
  | "booking.promotions.read" | "booking.promotions.write"
  | "airbnb.promotions.read" | "airbnb.promotions.write";

/** REAL : développée, fonctionne sur un logement réel · DEMO_ONLY : simulée sur les logements de démonstration seulement · NONE : non développée */
export type Built = "REAL" | "DEMO_ONLY" | "NONE";
/** Ce qui empêche de la développer : un accès partenaire que nous n'avons pas, ou les conditions du canal */
export type Blocker = "PARTNER_ACCESS" | "POLICY";

export type CapabilityDef = {
  id: CapabilityId;
  provider: Provider;
  kind: "read" | "write";
  label: string;
  built: Built;
  blocker?: Blocker;
  /** Ce que le code fait, ou ce qui manque, en une phrase */
  detail: string;
};

export const PROVIDER_INFO: Record<Provider, { name: string; role: string; next: string }> = {
  superhote: { name: "SuperHote", role: "PMS et channel manager · source des réservations", next: "Les webhooks (création, modification) ne sont pas développés : les réservations sont relues par l'API selon la cadence du logement. Connexion par logement : fiche du logement, onglet SuperHote." },
  pricelabs: { name: "PriceLabs", role: "Moteur de prix · grille, réglages et marché", next: "La connexion se fait par logement : fiche du logement, onglet PriceLabs, clé API. Lecture seule dans cette version : toute modification de prix passe par la procédure manuelle guidée." },
  booking: { name: "Booking.com", role: "Canal · promotions et commissions", next: "L'API Promotions exige un accès Connectivity Partner. D'ici là : procédure manuelle guidée, avec preuve." },
  airbnb: { name: "Airbnb", role: "Canal · promotions et commissions", next: "Aucune automatisation de navigateur : les conditions d'Airbnb l'interdisent. Procédure manuelle guidée, avec preuve." },
};

export const CAPABILITIES: CapabilityDef[] = [
  { id: "superhote.reconcile", provider: "superhote", kind: "read", label: "Lecture planifiée des réservations et du calendrier", built: "REAL",
    detail: "API v2 SuperHote en lecture seule (jeton par logement : rentals.read, calendar.read, reservations.read), relue selon la cadence du logement." },
  { id: "superhote.webhooks", provider: "superhote", kind: "read", label: "Réception des événements en temps réel (webhooks)", built: "NONE",
    detail: "Aucun point d'entrée n'existe dans cette version : les réservations sont relues par l'API, pas poussées par SuperHote." },
  { id: "pricelabs.read", provider: "pricelabs", kind: "read", label: "Lecture de la grille de prix, du marché et des réservations relayées", built: "REAL",
    detail: "API client PriceLabs en lecture seule (clé API par logement) : annonces, prix, marché, réservations." },
  { id: "pricelabs.write", provider: "pricelabs", kind: "write", label: "Écriture des prix et restrictions, après approbation", built: "DEMO_ONLY",
    detail: "Le client PriceLabs ne sait que lire. L'écriture n'est simulée que sur les logements de démonstration ; sur un logement réel, seule la procédure manuelle guidée s'applique. L'accès en écriture de l'API client reste à confirmer auprès de PriceLabs." },
  { id: "booking.promotions.read", provider: "booking", kind: "read", label: "Lecture des promotions", built: "NONE", blocker: "PARTNER_ACCESS",
    detail: "L'API Promotions de Booking.com exige un accès Connectivity Partner, non obtenu. Le registre des promotions se tient à la main." },
  { id: "booking.promotions.write", provider: "booking", kind: "write", label: "Écriture des promotions", built: "NONE", blocker: "PARTNER_ACCESS",
    detail: "Même dépendance que la lecture : accès Connectivity Partner non obtenu. Procédure manuelle guidée, avec preuve." },
  { id: "airbnb.promotions.read", provider: "airbnb", kind: "read", label: "Lecture des promotions", built: "NONE", blocker: "POLICY",
    detail: "Aucune API branchée ; l'automatisation du navigateur est exclue (conditions d'Airbnb, ADR-006). Le registre des promotions se tient à la main." },
  { id: "airbnb.promotions.write", provider: "airbnb", kind: "write", label: "Écriture des promotions", built: "NONE", blocker: "POLICY",
    detail: "Aucune automatisation de navigateur : les conditions d'Airbnb l'interdisent. Procédure manuelle guidée, avec preuve." },
];
export const capability = (id: string): CapabilityDef | undefined => CAPABILITIES.find((c) => c.id === id);
export const capabilitiesOf = (p: Provider): CapabilityDef[] => CAPABILITIES.filter((c) => c.provider === p);

/** État affiché d'une capacité. Le libellé dit toujours ce qui se passe : l'état n'est jamais porté par la couleur seule. */
export type Availability = "AVAILABLE" | "SIMULATED" | "NEEDS_CONNECTION" | "NOT_BUILT" | "NEEDS_ACCESS" | "FORBIDDEN";
export const AVAILABILITY: Record<Availability, { label: string; role: "sain" | "tech" | "neutre" }> = {
  AVAILABLE: { label: "Disponible", role: "sain" },
  SIMULATED: { label: "Simulée (démonstration)", role: "tech" },
  NEEDS_CONNECTION: { label: "À connecter", role: "neutre" },
  NOT_BUILT: { label: "Non développée", role: "neutre" },
  NEEDS_ACCESS: { label: "Accès partenaire requis", role: "neutre" },
  FORBIDDEN: { label: "Exclue (conditions du canal)", role: "neutre" },
};

/** Ce que l'on sait du compte : logements réels (hors démonstration), ceux qui sont branchés au fournisseur, logements de démonstration */
export type AccountFacts = { realTotal: number; realLinked: number; demoCount: number; killSwitch: boolean };
export type ResolvedCapability = {
  id: CapabilityId; label: string; kind: "read" | "write"; status: Availability;
  /** Utilisable maintenant : développée, branchée (ou simulée) et, pour une écriture, coupe-circuit levé */
  usable: boolean;
  /** Écriture bloquée par le coupe-circuit alors qu'elle serait sinon disponible */
  killed: boolean;
  reason: string;
};

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);
export function resolveCapability(def: CapabilityDef, f: AccountFacts): ResolvedCapability {
  let status: Availability, reason = def.detail;
  if (def.built === "NONE") status = def.blocker === "PARTNER_ACCESS" ? "NEEDS_ACCESS" : def.blocker === "POLICY" ? "FORBIDDEN" : "NOT_BUILT";
  else if (def.built === "DEMO_ONLY") status = f.demoCount > 0 ? "SIMULATED" : "NOT_BUILT";
  else if (f.realLinked > 0) { status = "AVAILABLE"; reason = `Branchée sur ${f.realLinked} logement${plural(f.realLinked, "", "s")} sur ${f.realTotal}. ${def.detail}`; }
  else if (f.demoCount > 0) status = "SIMULATED";
  else { status = "NEEDS_CONNECTION"; reason = (f.realTotal ? "Aucun de vos logements n'est branché. " : "Aucun logement réel pour l'instant. ") + def.detail; }
  const killed = def.kind === "write" && f.killSwitch && (status === "AVAILABLE" || status === "SIMULATED");
  return { id: def.id, label: def.label, kind: def.kind, status, usable: (status === "AVAILABLE" || status === "SIMULATED") && !killed, killed, reason };
}
export const resolveProvider = (p: Provider, f: AccountFacts): ResolvedCapability[] => capabilitiesOf(p).map((c) => resolveCapability(c, f));

/** Contrôle d'une écriture : la seule porte vers un fournisseur externe. Refus = aucune écriture, aucune exception à prévoir côté appelant. */
export type WriteCheck = { ok: true; simulated: boolean } | { ok: false; code: "UNKNOWN_CAPABILITY" | "KILL_SWITCH" | "NOT_SUPPORTED"; reason: string };
export function checkWrite(id: string, ctx: { isDemo: boolean; killSwitch: boolean }): WriteCheck {
  const def = capability(id);
  if (!def || def.kind !== "write") return { ok: false, code: "UNKNOWN_CAPABILITY", reason: "Capacité d'écriture inconnue : aucune écriture n'est faite." };
  const name = PROVIDER_INFO[def.provider].name;
  if (ctx.killSwitch) return { ok: false, code: "KILL_SWITCH", reason: `Coupe-circuit actif sur ${name} : aucune écriture possible.` };
  if (def.built === "NONE") return { ok: false, code: "NOT_SUPPORTED", reason: `L'écriture vers ${name} n'est pas possible : ${def.detail}` };
  if (def.built === "DEMO_ONLY" && !ctx.isDemo) return { ok: false, code: "NOT_SUPPORTED", reason: `L'écriture vers ${name} n'est pas développée pour un logement réel : utilisez la procédure manuelle guidée.` };
  return { ok: true, simulated: def.built === "DEMO_ONLY" };
}

/** Drapeaux de capacités d'UN logement, transmis au moteur et à l'auditeur. Coupe-circuit levé ou non, par fournisseur. */
export function capabilityFlags(ctx: { isDemo: boolean; killSwitch: Partial<Record<Provider, boolean>> }): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of CAPABILITIES) out[c.id] = c.kind === "write" ? checkWrite(c.id, { isDemo: ctx.isDemo, killSwitch: !!ctx.killSwitch[c.provider] }).ok : c.built !== "NONE";
  return out;
}

/** Fournisseur visé par l'action (`target.system`), null pour une tâche interne */
export const providerOfTarget = (system: string | undefined | null): Provider | null =>
  system === "PRICELABS" ? "pricelabs" : system === "BOOKING" ? "booking" : system === "AIRBNB" ? "airbnb" : null;

/**
 * Raison pour laquelle une action approuvée ne peut PAS être exécutée maintenant, ou null si elle le peut.
 * Appelée par `execute()` (refus côté API, avant tout changement d'état) et par la fiche du dossier (bouton désactivé) : une seule règle.
 */
export function executionBlock(mode: string | undefined, ctx: { provider: Provider | null; isDemo: boolean; killSwitch: boolean }): string | null {
  // le coupe-circuit ne coupe que l'écriture automatique par API ; la procédure manuelle (geste humain, avec preuve) reste possible
  // liste blanche : tout mode inconnu ou toute future écriture « API_* » est refusé tant qu'il n'a pas de capacité
  if (mode === "INTERNAL" || mode === "MANUAL_RUNBOOK") return null;
  if (mode === "API_PRICELABS") {
    // le coupe-circuit consulté est celui de la cible : une écriture PriceLabs visant un autre fournisseur est incohérente, donc refusée
    if (ctx.provider !== "pricelabs") return "Écriture par API incohérente avec la cible de l'action : aucune exécution possible.";
    const w = checkWrite("pricelabs.write", { isDemo: ctx.isDemo, killSwitch: ctx.killSwitch });
    return w.ok ? null : w.reason;
  }
  return "Mode d'exécution inconnu : aucune exécution possible.";
}

/** Fournisseurs ayant une écriture automatique développée (même simulée) : seuls ceux-là ont un coupe-circuit utile */
export const KILL_SWITCH_PROVIDERS: Provider[] = PROVIDERS.filter((p) => CAPABILITIES.some((c) => c.provider === p && c.kind === "write" && c.built !== "NONE"));

/** Statut d'ensemble d'un fournisseur, déduit des logements : jamais lu dans une ligne de base qui pourrait être périmée */
export type ProviderStatus = "DEMO" | "CONNECTED" | "NOT_CONNECTED" | "DEGRADED";
export function providerStatus(p: Provider, f: AccountFacts & { degraded?: boolean }): ProviderStatus {
  if (p === "booking" || p === "airbnb") return "NOT_CONNECTED";
  if (f.realLinked > 0) return f.degraded ? "DEGRADED" : "CONNECTED";
  return f.demoCount > 0 ? "DEMO" : "NOT_CONNECTED";
}

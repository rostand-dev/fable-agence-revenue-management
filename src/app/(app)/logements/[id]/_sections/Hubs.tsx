import { CadencePanel } from "@/components/CadencePanel";
import { HubCards, type HubState } from "@/components/PropertyHub";
import { pricelabsBadge, superhoteBadge } from "@/lib/integrations/connection-badge";
import { MAPPING_STATUS_LABEL } from "@/lib/mapping";
import { hubByKey, hubScreens, isLaunched, type HubKey, type ScreenKey } from "@/lib/property-hubs";
import { getMapping } from "@/lib/services/mapping";
import { listListings } from "@/lib/services/portfolio";
import { getQuality } from "@/lib/services/quality";
import { promosToVerify, sourcesToReview } from "./sources";
import type { Fiche } from "./context";

type States = Partial<Record<ScreenKey, HubState | null>>;
const s = (role: HubState["role"], label: string): HubState => ({ role, label });
const count = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function strategyStates({ p, input, now }: Fiche): States {
  const stale = promosToVerify({ input, now });
  return {
    strategie: p.status === "ONBOARDING" ? null : s("neutre", `Version ${p.strategyVersion}`),
    builder: p.strategyDraft ? s("attention", "Brouillon en cours") : null,
    canaux: input.promos.length === 0 ? null : stale ? s("attention", "Promotions à vérifier") : s("sain", count(input.promos.length, "promotion active", "promotions actives")),
  };
}

function economyStates({ p, model, miss }: Fiche): States {
  const provisional = model.provisional?.length ?? 0, seasons = model.seasons?.length ?? 0;
  return {
    couts: miss.length ? s("attention", count(miss.length, "donnée manquante", "données manquantes")) : provisional ? s("attention", count(provisional, "valeur à confirmer", "valeurs à confirmer")) : s("sain", "Complet"),
    planchers: miss.length ? s("attention", "Non calculés") : s("sain", "Calculés"),
    saisons: miss.length ? s("neutre", "Après les coûts") : seasons ? s("neutre", count(seasons, "saison", "saisons")) : null,
    versions: p.economicsVersion > 0 ? s("neutre", `Version ${p.economicsVersion} en vigueur`) : null,
  };
}

async function dataStates(f: Fiche): Promise<States> {
  const { user, p } = f;
  const launched = isLaunched(p);
  const [listings, mapping, quality] = await Promise.all([
    listListings(user.tenantId, p.id),
    launched ? getMapping(user.tenantId, p.id) : null,
    launched ? getQuality(user.tenantId, p.id) : null,
  ]);
  const check = p.superhote?.lastSync?.reservationCheck as { compared: number; onlySuperhote: number; onlyPriceLabs: number; amountDiffs: number } | undefined;
  const found = check ? check.onlySuperhote + check.onlyPriceLabs + check.amountDiffs : 0;
  // une comparaison qui n'a porté sur aucune réservation ne dit rien
  const gaps = check && (check.compared > 0 || found > 0) ? found : null;
  const active = listings.filter((l) => l.status === "ACTIVE").length;
  const toReview = sourcesToReview(f);
  const done = quality?.items.filter((i) => i.ok).length ?? 0;
  const validated = quality?.items.filter((i) => i.key === "floors" || i.key === "reconciliation") ?? [];
  const ok = validated.filter((i) => i.ok).length;
  return {
    superhote: superhoteBadge(p.superhote, p.isDemo),
    pricelabs: pricelabsBadge(p.pricelabs, p.isDemo),
    annonces: active ? s("neutre", count(active, "annonce active", "annonces actives")) : null,
    mapping: mapping ? s(mapping.status === "CONFIRMED" ? "sain" : mapping.status === "INCOMPLETE" ? "violation" : "attention", MAPPING_STATUS_LABEL[mapping.status]) : null,
    "qualite-donnees": toReview ? s("attention", count(toReview, "source à revoir", "sources à revoir")) : s("sain", "Rien à revoir"),
    checklist: quality ? s(done === quality.items.length ? "sain" : "attention", `${done} sur ${quality.items.length} vérifiés`) : null,
    ecarts: gaps === null ? null : gaps ? s("attention", count(gaps, "écart", "écarts")) : s("sain", "Aucun écart"),
    validations: validated.length ? s(ok === validated.length ? "sain" : "attention", `${ok} sur ${validated.length} validées`) : null,
  };
}

/** Hub d'une rubrique : ses écrans, chacun avec l'état connu. */
export async function Hub({ hub, fiche }: { hub: HubKey; fiche: Fiche }) {
  const { p } = fiche;
  const states = hub === "strategie" ? strategyStates(fiche) : hub === "economie" ? economyStates(fiche) : await dataStates(fiche);
  const def = hubByKey(hub);
  return (
    <section className="stack" data-testid={`hub-${hub}`}>
      <div><h2 style={{ fontSize: 18, margin: 0 }}>{def.label}</h2><p className="section-note" style={{ margin: "4px 0 0" }}>{def.description}</p></div>
      <HubCards label={`Écrans : ${def.label}`} cards={hubScreens(hub, p).map((x) => ({ key: x.key, href: x.href, title: x.label, description: x.description, state: states[x.key] }))} />
      {hub === "donnees" && <CadencePanel cadence={p.cadence} isDemo={p.isDemo} hasPriceLabs={!!p.pricelabs?.listingId} hasSuperhote={!!p.superhote?.rentalId} nextReservationsAt={p.nextReservationsAt} nextPricesAt={p.nextPricesAt} nextReviewAt={p.nextReviewAt} now={fiche.now} />}
    </section>
  );
}

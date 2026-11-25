import type { TodoItem } from "@/components/TodoCard";
import { agentName } from "@/lib/agents/registry";
import { isLaunched } from "@/lib/property-hubs";
import type { ChannelMarkup } from "@/lib/pricing/published";
import type { Fiche } from "./context";

/** Ce qui demande une action sur le logement. Pendant la création, tout se complète dans le parcours guidé. */
export function todoItems({ p, sp, model, miss, names, onboarding, hasCal }: Fiche, tab: string): TodoItem[] {
  const base = `/logements/${p.id}`;
  const items: TodoItem[] = [];
  // l'onglet SuperHote affiche déjà l'erreur au-dessus de son formulaire
  if (!p.isDemo && tab !== "superhote") {
    const open = { href: `${base}?tab=superhote`, label: "Ouvrir SuperHote" };
    if (sp.erreurSh) items.push({ key: "superhote", title: "La connexion à SuperHote a échoué", body: <>{sp.erreurSh} Ressaisissez le jeton dans l'écran SuperHote.</>, action: open });
    // une lecture en échec n'accuse pas le jeton : le message de la lecture dit ce qui s'est passé
    else if (!onboarding && p.superhote?.lastSync?.ok === false) items.push({ key: "superhote", title: "Dernière lecture SuperHote en échec", body: <>{(p.superhote.lastSync.error as string | undefined) ?? "La dernière lecture a échoué."}</>, action: open });
  }
  if (isLaunched(p)) {
    const markups = (p.channelMarkups ?? []) as ChannelMarkup[];
    const missing = Object.keys(model.channels ?? {}).map((c) => (c === "AIRBNB" ? { k: "airbnb", l: "Airbnb" } : { k: "booking", l: "Booking.com" })).filter((c) => !markups.some((m) => (m.key === c.k || m.key.startsWith(c.k + "-")) && m.pct !== null)).map((c) => c.l);
    if (missing.length) items.push({ key: "majoration", title: "Majoration non renseignée", body: <>Majoration SuperHote manquante pour {missing.join(" et ")}. Sans elle, le prix vendu sur ce canal ne peut pas être calculé : il est exclu de la revue des agents.</>, action: { href: `${base}/modifier`, label: "Saisir la majoration" } });
  }
  if (miss.length > 0 && !onboarding) items.push({ key: "economie", title: "Modèle économique incomplet", body: <>Il manque : {miss.join(", ")}. Aucun plancher n'est calculé et aucune situation n'est ouverte tant que ces valeurs manquent ; une estimation provisoire suffit pour démarrer.</>, action: p.isDemo ? undefined : { href: `${base}/couts`, label: `Les renseigner pas à pas avec ${agentName("onboarding", names)}` } });
  if (!hasCal && !onboarding && tab !== "pricelabs") items.push({ key: "calendrier", title: "Calendrier non connecté", body: <>La revue démarre dès que la clé API PriceLabs de ce logement est renseignée.</>, action: { href: `${base}?tab=pricelabs`, label: "Connecter PriceLabs" } });
  const provisional = model.provisional ?? [];
  const floors = miss.length === 0 && tab !== "economie" ? { href: `${base}?tab=economie`, label: "Voir les planchers" } : p.isDemo ? undefined : { href: `${base}/couts`, label: "Confirmer les valeurs" };
  if (provisional.length && !onboarding) items.push({ key: "provisoire", title: `Planchers provisoires : ${provisional.length} valeur${provisional.length > 1 ? "s" : ""} à confirmer`, body: <>{provisional.join(", ")}. Les planchers en dépendent ; les dossiers ouverts portent la même mention.</>, action: floors });
  return items;
}

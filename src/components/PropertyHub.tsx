import Link from "next/link";
import { Icon } from "./Icon";
import { State } from "./ui";
import { HUBS, hubScreens, isLaunched, type PropertyRef } from "@/lib/property-hubs";

/** État lisible d'une carte : un libellé et une forme, jamais la couleur seule. Absent quand la donnée n'existe pas. */
export type HubState = { role: "sain" | "attention" | "violation" | "neutre"; label: string };
export type HubCard = { key: string; href: string; title: string; description: string; state?: HubState | null; foot?: string };

export function HubCards({ cards, label }: { cards: HubCard[]; label: string }) {
  return (
    <ul className="hub-grid" aria-label={label}>
      {cards.map((c) => (
        <li key={c.key}>
          <Link className="hub-card" href={c.href} data-testid={`hub-card-${c.key}`}>
            <span className="hub-card-title">{c.title}<Icon name="arrow" /></span>
            <span className="hub-card-text">{c.description}</span>
            {c.state && <State role={c.state.role}>{c.state.label}</State>}
            {c.foot && <span className="hub-card-foot">{c.foot}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Vue d'ensemble : les trois rubriques, chacune avec un raccourci vers chacun de ses écrans, puis les écrans hors rubrique.
 * Sans ces raccourcis, un écran de rubrique demanderait plus de trois gestes depuis l'accueil sur tablette et mobile.
 */
export function PropertyHubLinks({ property, canEdit, canDelete }: { property: PropertyRef; canEdit: boolean; canDelete: boolean }) {
  const base = `/logements/${property.id}`;
  return (
    <>
      <ul className="hub-grid" aria-label="Rubriques du logement">
        {HUBS.map((h) => (
          <li key={h.key}>
            <div className="hub-card hub-card-open">
              <Link className="hub-card-head" href={`${base}?tab=${h.tab}`} data-testid={`hub-card-${h.key}`}>
                <span className="hub-card-title">{h.label}<Icon name="arrow" /></span>
                <span className="hub-card-text">{h.description}</span>
              </Link>
              <ul className="hub-shortcuts" aria-label={`Raccourcis : ${h.label}`}>
                {hubScreens(h.key, property).map((x) => <li key={x.key}><Link href={x.href}>{x.label}</Link></li>)}
              </ul>
            </div>
          </li>
        ))}
      </ul>
      <ul className="hub-shortcuts hub-others" aria-label="Autres écrans du logement">
        <li><Link href={`${base}?tab=calendrier`}>Calendrier 90 jours</Link></li>
        <li><Link href={`${base}?tab=historique`}>Historique du logement</Link></li>
        {canEdit && isLaunched(property) && <li><Link href={`${base}/modifier`}>Modifier le dossier</Link></li>}
        {canDelete && isLaunched(property) && <li><Link className="hub-shortcut-danger" href={`${base}/supprimer`}>Supprimer le logement</Link></li>}
      </ul>
    </>
  );
}

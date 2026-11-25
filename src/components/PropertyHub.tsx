import Link from "next/link";
import { Icon } from "./Icon";
import { State } from "./ui";
import { HUBS, hubScreens, type PropertyRef } from "@/lib/property-hubs";

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

/** Les trois portes d'entrée de la vue d'ensemble. */
export function PropertyHubLinks({ property }: { property: PropertyRef }) {
  return <HubCards label="Rubriques du logement" cards={HUBS.map((h) => {
    const n = hubScreens(h.key, property).length;
    return { key: h.key, href: `/logements/${property.id}?tab=${h.tab}`, title: h.label, description: h.description, foot: `${n} écran${n > 1 ? "s" : ""}` };
  })} />;
}

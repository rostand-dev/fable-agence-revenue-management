import Link from "next/link";
import { resetDemoAction, reviewAction } from "@/app/actions/decisions";
import { inboxHref, urgent, type InboxQuery } from "@/lib/inbox";
import type { OppWithAction } from "@/lib/queries";
import { denyMessage, type Role } from "@/lib/rbac";
import { FilterSheet } from "./FilterSheet";
import { ActionForm, Submit } from "./forms";
import { InboxFilterForm, StatusChips } from "./InboxFilters";
import { SitCardCompact } from "./SitCardCompact";
import { Banner, State } from "./ui";

export type PocketInboxProps = {
  q: InboxQuery;
  all: OppWithAction[]; shown: OppWithAction[]; ranks: Map<string, number>;
  properties: { id: string; name: string }[]; playbooks: string[]; provisional: Set<string>;
  nbFilters: number; today: string; blocked: number;
  role: Role; canDecide: boolean;
  /** bandeau des logements de démonstration ; null : aucun (ou déjà annoncé par la démo en lecture seule) */
  demo: { canReset: boolean } | null;
  empty: { title: string; text: string };
};

/** Mode poche : les situations d'abord. La synthèse, l'équipe et les textes d'introduction restent à la version complète. */
export function PocketInbox({ q, all, shown, ranks, properties, playbooks, provisional, nbFilters, today, blocked, role, canDecide, demo, empty }: PocketInboxProps) {
  const pname = new Map(properties.map((p) => [p.id, p.name]));
  const open = all.filter((o) => o.status === "OPEN");
  // les compteurs des puces suivent les filtres de logement et de playbook, comme la liste qu'elles ouvrent
  const scope = open.filter((o) => (!q.p || o.propertyId === q.p) && (!q.pb || o.playbook === q.pb));
  const chips = [
    { key: "a-traiter", label: "À traiter", count: scope.length, u: "" },
    { key: "urgent", label: "Urgents", count: scope.filter((o) => urgent(o, today)).length, u: "urgent" },
  ];
  const filtered = nbFilters > 0 || q.s !== "priorite";
  return (
    <div className="pk-screen">
      {demo && (
        <div className="mode-strip pk-demo" data-testid="bandeau-demo">
          <State role="tech">Démo</State>
          <span>Données synthétiques</span>
          {demo.canReset && <ActionForm need="workspace.manage" action={resetDemoAction} className="inline"><Submit className="btn btn-ghost" pendingLabel="…" ariaLabel="Réancrer à aujourd'hui">Réancrer</Submit></ActionForm>}
        </div>
      )}
      <div className="pk-head">
        <h1>Opportunités</h1>
        <p>{open.length === 0 ? "rien à arbitrer" : `${open.length} à arbitrer`}</p>
      </div>
      {blocked > 0 && <p className="pk-alert" role="status">{blocked} logement{blocked > 1 ? "s" : ""} hors revue faute de données. <Link href="/logements">Voir</Link></p>}
      {!canDecide && <div data-testid="lecture-seule"><Banner role="tech" title="Lecture seule">{denyMessage(role, "decision.decide")}</Banner></div>}
      {/* sans carte ouverte, le menu « … » n'existe pas : la revue (qui rouvre aussi les dossiers différés) se lance d'ici */}
      {open.length === 0 && canDecide && <ActionForm action={reviewAction} className="pk-review"><Submit className="btn btn-ghost" icon="spin" pendingLabel="Revue en cours…">Relancer la revue</Submit></ActionForm>}
      <div className="pk-chips">
        <div className="pk-chips-list" role="group" aria-label="Raccourcis">
          {chips.map((c) => <Link key={c.key} className="chip" href={inboxHref(q, { f: "a-traiter", u: c.u })} aria-current={q.f === "a-traiter" && q.u === c.u ? "true" : undefined} scroll={false}>{c.label} · {c.count}</Link>)}
        </div>
        <FilterSheet active={nbFilters}>
          <StatusChips q={q} />
          {/* champs non contrôlés : une nouvelle adresse reconstruit le formulaire */}
          <InboxFilterForm key={inboxHref(q, {})} q={q} properties={properties} playbooks={playbooks} reset={false} />
        </FilterSheet>
      </div>
      {/* sans filtre ni tri, le compte redit le titre : il reste lu par les lecteurs d'écran seulement */}
      <div className={filtered ? "pk-count" : "visually-hidden"}>
        <p role="status" data-testid="inbox-compteur" className="inbox-count">{shown.length} résultat{shown.length > 1 ? "s" : ""}{nbFilters > 0 ? ` · ${nbFilters} filtre${nbFilters > 1 ? "s" : ""} actif${nbFilters > 1 ? "s" : ""}` : ""}{q.s !== "priorite" ? " · rang de priorité conservé" : ""}</p>
        {nbFilters > 0 && <Link href="/" data-testid="reinitialiser">Réinitialiser</Link>}
      </div>
      {shown.length > 0 ? (
        <div className="pk-list-cards">{shown.map((o) => <SitCardCompact key={o.id} o={o} rank={ranks.get(o.id) ?? null} propertyName={pname.get(o.propertyId) ?? ""} provisional={provisional.has(o.propertyId)} canDecide={canDecide} />)}</div>
      ) : (
        <div className="empty"><h3>{empty.title}</h3><p>{empty.text}</p></div>
      )}
    </div>
  );
}

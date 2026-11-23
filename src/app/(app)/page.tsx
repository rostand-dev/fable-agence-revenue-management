import Link from "next/link";
import { Term } from "@/components/Term";
import { resetDemoAction, reviewAction } from "@/app/actions/decisions";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { SitCard } from "@/components/SitCard";
import { Banner, Metric, State, Vq } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { AGENTS } from "@/lib/agents/registry";
import { getLlmStatus } from "@/lib/agents/llm-config";
import { requireUser } from "@/lib/auth";
import { can, denyMessage } from "@/lib/rbac";
import { diffDays, fmtDate, fmtDateTime, todayISO } from "@/lib/dates";
import type { Candidate } from "@/lib/engine/types";
import { signedEuro } from "@/lib/format";
import { lastReview, listOpportunities, listProperties } from "@/lib/queries";
import {
  activeFilters, applyInbox, guarded, inboxHref, parseInboxQuery, priorityRanks, SORTS, STATUS_FILTERS, URGENCY_FILTERS,
} from "@/lib/inbox";


export default async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const raw = await searchParams;
  const canDecide = can(user.role, "decision.decide");
  const [props, all, review] = await Promise.all([listProperties(user.tenantId), listOpportunities(user.tenantId, ["OPEN", "DEFERRED", "DECIDED"]), lastReview(user.tenantId)]);
  const llmOn = (await getLlmStatus(user.tenantId)).source !== "aucune";
  const playbooks = [...new Set(all.map((o) => o.playbook))].sort();
  const q = parseInboxQuery(raw, { propertyIds: props.map((p) => p.id), playbooks });
  const names = user.settings.agentNames ?? null;
  const pname = new Map(props.map((p) => [p.id, p.name]));
  const prov = new Set(props.filter((p) => ((p.economics as any)?.provisional?.length ?? 0) > 0).map((p) => p.id));
  const open = all.filter((o) => o.status === "OPEN");
  const sel = (o: (typeof all)[number]) => (o.candidates as Candidate[])[o.selected];
  const guard = open.filter(guarded);
  const ranks = priorityRanks(all);
  const shown = applyInbox(all, q, todayISO());
  const nbFilters = activeFilters(q);
  const chiffrables = open.filter((o) => sel(o).type !== "NO_ACTION" && sel(o).expectedDeltaCents !== null);
  const impact = chiffrables.reduce((a, o) => a + (sel(o).expectedDeltaCents ?? 0), 0);
  const today = todayISO();
  const anchor: string | undefined = user.settings.demoAnchor;
  const hasDemo = props.some((p) => p.isDemo), stale = anchor ? diffDays(today, anchor) : 0;
  const nights = props.length * 91;
  // chaque logement est revu à son rythme : le blocage se lit sur le logement, plus sur la dernière revue du compte
  const blocked = props.filter((p) => p.cadence?.blocked).length;

  // Compte neuf : rien à arbitrer tant qu'aucun logement n'existe, on guide vers la première étape.
  if (props.length === 0) {
    return (
      <Page title="Opportunités" sub="Bienvenue" crumbs={[{ label: "Opportunités" }]}>
        <div className="page-head">
          <h1>Commençons par votre premier logement</h1>
          <p>L'agence travaille logement par logement. Ajoutez le vôtre : l'équipe vous guide ensuite pour renseigner ses coûts et brancher vos outils, puis elle ne vous présente que les exceptions à arbitrer.</p>
        </div>
        <div className="empty">
          <h3>Aucun logement pour le moment</h3>
          <p style={{ marginBottom: 16 }}>Vous pourrez enregistrer votre saisie et la reprendre plus tard.</p>
          <Link className="btn btn-primary" href="/logements/nouveau"><Icon name="plus" />Ajouter mon premier logement</Link>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Opportunités" sub={review ? `Revue du ${fmtDateTime(review.startedAt)} · ${props.length} logement${props.length > 1 ? "s" : ""}` : "Aucune revue encore lancée"} crumbs={[{ label: "Opportunités" }]}>
      {hasDemo && (
        <div className="mode-strip" style={{ marginBottom: 20 }}>
          <State role="tech">Mode démonstration</State>
          <span>Les logements marqués « démo » reposent sur des <strong>données synthétiques</strong>{anchor ? `, ancrées au ${fmtDate(anchor)}` : ""}. Les écritures PriceLabs y sont simulées.</span>
          {stale >= 3 && canDecide && <ActionForm action={resetDemoAction} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo" pendingLabel="Réinstallation…">Réancrer à aujourd'hui</Submit></ActionForm>}
        </div>
      )}
      <div className="page-head">
        <h1>{open.length === 0 ? "Aucune situation à arbitrer aujourd'hui" : `${open.length} situation${open.length > 1 ? "s" : ""} à arbitrer sur ${nights} nuits analysées`}</h1>
        <p>L'agence ne vous présente que les exceptions. Chaque situation se lit dans le même ordre : signal observé, période, hypothèse, puis option proposée. Les montants sont des simulations rattachées à leur hypothèse ; un chiffre absent porte son qualificatif, jamais un zéro.</p>
      </div>

      <div className="card card-quiet row-wrap" style={{ marginBottom: 14 }}>
        <div className="crew">{AGENTS.map((a) => <Avatar key={a.id} agent={a.id} size={34} title={`${names?.[a.id] ?? a.name}, ${a.title}`} />)}</div>
        <p className="muted od-fill" style={{ margin: 0, minWidth: 220 }}>
          {review ? <>Dernière revue de l'équipe : <strong style={{ color: "var(--ink)" }}>{fmtDateTime(review.startedAt)}</strong>. {llmOn ? "Synthèses rédigées avec le modèle de langage." : "Synthèses en mode déterministe (aucune clé API renseignée)."}</> : "L'équipe n'a pas encore passé vos logements en revue."}
          {" "}<Link href="/equipe">Voir l'équipe</Link>
        </p>
        {canDecide && <ActionForm action={reviewAction} className="inline"><Submit className="btn btn-ghost btn-sm" icon="spin" pendingLabel="Revue en cours…">Relancer la revue</Submit></ActionForm>}
      </div>
      {blocked > 0 && <Banner role="attention" title={`${blocked} logement${blocked > 1 ? "s" : ""} hors revue faute de données`} style={{ marginBottom: 14 }}>Aucune opportunité n'est ouverte tant que le calendrier ou le modèle économique est inconnu. <Link href="/logements">Compléter les logements</Link></Banner>}

      {!canDecide && <div data-testid="lecture-seule" style={{ marginBottom: 14 }}><Banner role="tech" title="Lecture seule">{denyMessage(user.role, "decision.decide")} Vous pouvez parcourir les situations et ouvrir chaque dossier.</Banner></div>}

      <section className="section" aria-labelledby="synth-h" style={{ marginTop: 8 }}>
        <h2 id="synth-h" className="visually-hidden">Synthèse quotidienne</h2>
        <div className="synth">
          <Metric label="Situations ouvertes" value={open.length} source={`${all.filter((o) => o.status === "DEFERRED").length} différée(s) · revue au rythme de chaque logement`} />
          <Metric label="Impact net simulé" value={chiffrables.length ? signedEuro(impact) : <Vq kind="nonchiffrable">Non chiffrable</Vq>} unit={chiffrables.length ? "net" : undefined} source={`Somme des ${chiffrables.length} options chiffrables · simulation, pas un revenu acquis`} />
          <Metric label="Décisions enregistrées" value={all.filter((o) => o.status === "DECIDED").length} source="Approbations, rejets et inactions retenues" />
          <Metric label={<>Garde-fous & <Term id="veto">vetos</Term></>} value={guard.length} tone={guard.some((o) => o.veto) ? "veto" : undefined} source={`${open.filter((o) => o.veto).length} veto · ${guard.length - open.filter((o) => o.veto).length} option(s) rejetée(s) par l'auditeur`} />
        </div>
      </section>

      <section className="section" aria-labelledby="file-h">
        <h2 id="file-h">Opportunités classées par priorité</h2>
        <p className="section-note">La synthèse ci-dessus porte sur tout le portefeuille, hors filtres. Un veto passe toujours en tête. Le rang suit ensuite la valeur simulée, pondérée par la confiance, l'urgence et le risque.</p>
        <div className="filters" role="group" aria-label="Filtrer par statut">
          {STATUS_FILTERS.map(([k, label]) => <Link key={k} className="chip" href={inboxHref(q, { f: k })} aria-current={q.f === k ? "true" : undefined} scroll={false}>{label}</Link>)}
        </div>
        <form method="get" action="/" className="inbox-filters" data-testid="inbox-filtres" aria-label="Affiner la liste">
          {q.f !== "a-traiter" && <input type="hidden" name="f" value={q.f} />}
          <label>Logement
            <select name="p" defaultValue={q.p}><option value="">Tous les logements</option>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <label>Playbook
            <select name="pb" defaultValue={q.pb}><option value="">Tous les playbooks</option>{playbooks.map((pb) => <option key={pb} value={pb}>{pb}</option>)}</select>
          </label>
          <label>Urgence
            <select name="u" defaultValue={q.u}>{URGENCY_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
          </label>
          <label>Tri
            <select name="s" defaultValue={q.s}>{SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
          </label>
          <div className="inbox-filters-actions">
            <button type="submit" className="btn btn-primary btn-sm">Appliquer</button>
            {nbFilters > 0 && <Link className="btn btn-ghost btn-sm" href="/" data-testid="reinitialiser">Réinitialiser</Link>}
          </div>
        </form>
        <p role="status" data-testid="inbox-compteur" className="inbox-count">{shown.length} résultat{shown.length > 1 ? "s" : ""}{nbFilters > 0 ? ` · ${nbFilters} filtre${nbFilters > 1 ? "s" : ""} actif${nbFilters > 1 ? "s" : ""}` : ""}{q.s !== "priorite" ? " · rang de priorité conservé" : ""}</p>
        {shown.length > 0 ? (
          <div className="inbox">{shown.map((o) => <SitCard key={o.id} o={o} rank={ranks.get(o.id) ?? null} propertyName={pname.get(o.propertyId) ?? ""} names={names} provisional={prov.has(o.propertyId)} canDecide={canDecide} />)}</div>
        ) : (
          <div className="empty">
            <h3>{nbFilters > 0 ? "Aucun résultat avec ces filtres" : q.f === "a-traiter" ? "Rien à arbitrer" : "Aucune entrée"}</h3>
            <p>{nbFilters > 0 ? "Aucune situation ne correspond à cette combinaison. Élargissez ou réinitialisez les filtres : ce n'est pas une confirmation qu'il n'y a rien à traiter." : q.f === "a-traiter" ? "L'équipe n'a relevé aucune exception qui mérite une décision. Ne rien faire est ici la bonne décision." : "Un registre vide ne vaut pas confirmation : il signifie qu'aucune situation de ce type n'a été relevée."}</p>
          </div>
        )}
      </section>
      <p className="foot">Montants en euros, hors taxes de séjour. Origine des données : SuperHote (calendrier, réservations) et PriceLabs (grille de prix, marché) — simulées pour les logements de démonstration. Aucune écriture externe n'est faite sans approbation explicite.</p>
    </Page>
  );
}

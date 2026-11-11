import Link from "next/link";
import { resetDemoAction, reviewAction } from "@/app/actions/decisions";
import { Avatar } from "@/components/Avatar";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { SitCard } from "@/components/SitCard";
import { Banner, Metric, State, Vq } from "@/components/ui";
import { AGENTS } from "@/lib/agents/registry";
import { llmEnabled } from "@/lib/agents/llm";
import { requireUser } from "@/lib/auth";
import { diffDays, fmtDate, fmtDateTime, todayISO } from "@/lib/dates";
import type { Candidate } from "@/lib/engine/types";
import { signedEuro } from "@/lib/format";
import { lastReview, listOpportunities, listProperties } from "@/lib/queries";

const FILTERS = [["a-traiter", "À traiter"], ["garde-fous", "Garde-fous & vetos"], ["traitees", "Traitées"], ["toutes", "Toutes"]] as const;

export default async function Inbox({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const user = await requireUser();
  const f = (await searchParams).f ?? "a-traiter";
  const [props, all, review] = await Promise.all([listProperties(user.tenantId), listOpportunities(user.tenantId, ["OPEN", "DEFERRED", "DECIDED"]), lastReview(user.tenantId)]);
  const names = user.settings.agentNames ?? null;
  const pname = new Map(props.map((p) => [p.id, p.name]));
  const open = all.filter((o) => o.status === "OPEN");
  const sel = (o: (typeof all)[number]) => (o.candidates as Candidate[])[o.selected];
  const guard = open.filter((o) => o.veto || (o.candidates as Candidate[]).some((c) => c.audit.verdict === "REJECT"));
  const shown = f === "garde-fous" ? guard : f === "traitees" ? all.filter((o) => o.status !== "OPEN") : f === "toutes" ? all : open;
  const chiffrables = open.filter((o) => sel(o).type !== "NO_ACTION" && sel(o).expectedDeltaCents !== null);
  const impact = chiffrables.reduce((a, o) => a + (sel(o).expectedDeltaCents ?? 0), 0);
  const today = todayISO();
  const anchor: string | undefined = user.settings.demoAnchor;
  const hasDemo = props.some((p) => p.isDemo), stale = anchor ? diffDays(today, anchor) : 0;
  const nights = props.length * 91;
  const blocked = Number(review?.stats?.blocked ?? 0);

  return (
    <Page title="Opportunités" sub={review ? `Revue du ${fmtDateTime(review.startedAt)} · ${props.length} logement${props.length > 1 ? "s" : ""}` : "Aucune revue encore lancée"} crumbs={[{ label: "Opportunités" }]}>
      {hasDemo && (
        <div className="mode-strip" style={{ marginBottom: 20 }}>
          <State role="tech">Mode démonstration</State>
          <span>Les logements marqués « démo » reposent sur des <strong>données synthétiques</strong>{anchor ? `, ancrées au ${fmtDate(anchor)}` : ""}. Les écritures PriceLabs y sont simulées.</span>
          {stale >= 3 && <ActionForm action={resetDemoAction} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo" pendingLabel="Réinstallation…">Réancrer à aujourd'hui</Submit></ActionForm>}
        </div>
      )}
      <div className="page-head">
        <h1>{open.length === 0 ? "Aucune situation à arbitrer aujourd'hui" : `${open.length} situation${open.length > 1 ? "s" : ""} à arbitrer sur ${nights} nuits analysées`}</h1>
        <p>L'agence ne vous présente que les exceptions. Chaque situation se lit dans le même ordre : signal observé, période, hypothèse, puis option proposée. Les montants sont des simulations rattachées à leur hypothèse ; un chiffre absent porte son qualificatif, jamais un zéro.</p>
      </div>

      <div className="card card-quiet row-wrap" style={{ marginBottom: 14 }}>
        <div className="crew">{AGENTS.map((a) => <Avatar key={a.id} agent={a.id} size={34} title={`${names?.[a.id] ?? a.name}, ${a.title}`} />)}</div>
        <p className="muted od-fill" style={{ margin: 0, minWidth: 220 }}>
          {review ? <>Dernière revue de l'équipe : <strong style={{ color: "var(--ink)" }}>{fmtDateTime(review.startedAt)}</strong>. {llmEnabled() ? "Synthèses rédigées avec le modèle de langage." : "Synthèses en mode déterministe (aucune clé API renseignée)."}</> : "L'équipe n'a pas encore passé vos logements en revue."}
          {" "}<Link href="/equipe">Voir l'équipe</Link>
        </p>
        <ActionForm action={reviewAction} className="inline"><Submit className="btn btn-ghost btn-sm" icon="spin" pendingLabel="Revue en cours…">Relancer la revue</Submit></ActionForm>
      </div>
      {blocked > 0 && <Banner role="attention" title={`${blocked} logement${blocked > 1 ? "s" : ""} hors revue faute de données`} style={{ marginBottom: 14 }}>Aucune opportunité n'est ouverte tant que le calendrier ou le modèle économique est inconnu. <Link href="/logements">Compléter les logements</Link></Banner>}

      <section className="section" aria-labelledby="synth-h" style={{ marginTop: 8 }}>
        <h2 id="synth-h" className="visually-hidden">Synthèse quotidienne</h2>
        <div className="synth">
          <Metric label="Situations ouvertes" value={open.length} source={`${all.filter((o) => o.status === "DEFERRED").length} différée(s) · revue quotidienne`} />
          <Metric label="Impact net simulé" value={chiffrables.length ? signedEuro(impact) : <Vq kind="nonchiffrable">Non chiffrable</Vq>} unit={chiffrables.length ? "net" : undefined} source={`Somme des ${chiffrables.length} options chiffrables · simulation, pas un revenu acquis`} />
          <Metric label="Décisions enregistrées" value={all.filter((o) => o.status === "DECIDED").length} source="Approbations, rejets et inactions retenues" />
          <Metric label="Garde-fous & vetos" value={guard.length} tone={guard.some((o) => o.veto) ? "veto" : undefined} source={`${open.filter((o) => o.veto).length} veto · ${guard.length - open.filter((o) => o.veto).length} option(s) rejetée(s) par l'auditeur`} />
        </div>
      </section>

      <section className="section" aria-labelledby="file-h">
        <h2 id="file-h">Opportunités classées par priorité</h2>
        <p className="section-note">Un veto passe toujours en tête. Le rang suit ensuite la valeur simulée, pondérée par la confiance, l'urgence et le risque.</p>
        <div className="filters" role="group" aria-label="Filtrer le registre">
          {FILTERS.map(([k, label]) => <Link key={k} className="chip" href={k === "a-traiter" ? "/" : `/?f=${k}`} aria-current={f === k ? "true" : undefined} scroll={false}>{label}</Link>)}
        </div>
        {shown.length > 0 ? (
          <div className="inbox">{shown.map((o) => <SitCard key={o.id} o={o} rank={o.status === "OPEN" ? open.indexOf(o) + 1 : null} propertyName={pname.get(o.propertyId) ?? ""} names={names} />)}</div>
        ) : (
          <div className="empty">
            <h3>{f === "a-traiter" ? "Rien à arbitrer" : "Aucune entrée"}</h3>
            <p>{f === "a-traiter" ? "L'équipe n'a relevé aucune exception qui mérite une décision. Ne rien faire est ici la bonne décision." : "Un registre vide ne vaut pas confirmation : il signifie qu'aucune situation de ce type n'a été relevée."}</p>
          </div>
        )}
      </section>
      <p className="foot">Montants en euros, hors taxes de séjour. Origine des données : SuperHote (calendrier, réservations) et PriceLabs (grille de prix, marché) — simulées pour les logements de démonstration. Aucune écriture externe n'est faite sans approbation explicite.</p>
    </Page>
  );
}

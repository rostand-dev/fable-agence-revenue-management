import { Avatar } from "@/components/Avatar";
import { Page } from "@/components/Page";
import { State } from "@/components/ui";
import { agentName, WORKFLOWS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { CYCLE } from "@/lib/engine/stateMachine";

export const metadata = { title: "Méthode de travail" };
const SPLIT: [string, string, string][] = [
  ["Calcul des planchers, cascade du revenu net, cumul des remises", "Règles déterministes", "Aucun modèle de langage ne décide si un prix est rentable."],
  ["Détection des signaux, dédoublonnage, classement de la file", "Règles déterministes", "Reproductible d'un jour à l'autre, testable."],
  ["Audit et veto, machine à états, droits", "Règles déterministes", "Un garde-fou ne se négocie pas."],
  ["Synthèse des dossiers, réponses à vos questions, bilan mensuel", "Modèle de langage, sur faits certifiés", "Il explique ; il n'ajoute aucun chiffre et n'exécute rien."],
];
const AUTONOMY: [string, string, string][] = [
  ["Recommandation sans écriture", "faible", "Automatique"], ["Séjour minimum réduit pour combler un trou de 3 nuits au plus", "faible à moyen", "Sur votre approbation"],
  ["Prix daté dans ±5 %, 14 nuits au plus", "moyen", "Sur votre approbation"], ["Variation au-delà de ±5 % ou prix de base", "élevé", "Approbation commentée"],
  ["Promotion de canal jusqu'à 10 %", "moyen", "Approbation + procédure manuelle guidée"], ["Toute action sous le plancher absolu", "interdit", "Veto de l'auditeur"],
];

export default async function Methode() {
  const user = await requireUser();
  const names = user.settings.agentNames ?? null;
  return (
    <Page title="Méthode de travail" sub="Workflows, garde-fous et partage des rôles" crumbs={[{ label: "Agence IA" }, { label: "Méthode de travail" }]}>
      <div className="page-head">
        <h1>Comment travaille l'agence</h1>
        <p>La règle centrale : une occupation faible n'entraîne jamais automatiquement une baisse de prix. L'équipe établit d'abord un diagnostic causal — demande, fenêtre de réservation, prix, restriction, promotion, annonce — puis compare les options, dont celle de ne rien faire.</p>
      </div>
      <section className="section" style={{ marginTop: 0 }}>
        <h2>Le cycle d'une décision</h2>
        <p className="section-note">Huit étapes traçables. Les quatre premières sont faites par l'équipe avant que vous ne voyiez le dossier.</p>
        <ol className="frieze">{CYCLE.map((n, i) => <li key={n} className={i < 4 ? "is-fait" : i === 4 ? "is-encours" : "is-avenir"}><span className="fr-step"><span className="fr-glyph" /><span className="fr-no">{i + 1}/8</span></span><span className="fr-name">{n}</span><span className="fr-state">{i < 4 ? "équipe" : i === 4 ? "vous" : i === 5 ? "équipe ou vous" : "équipe"}</span></li>)}</ol>
      </section>
      {WORKFLOWS.map((w) => (
        <section className="section" key={w.id}>
          <h2>{w.name}</h2><p className="section-note">{w.cadence} · {w.purpose}</p>
          <ol className="flow">{w.steps.map((s, i) => <li key={i}><span className="n">{i + 1}</span><span className={`who${s.agent === "vous" ? " is-you" : ""}`}>{s.agent === "vous" ? "Vous" : <><Avatar agent={s.agent} size={24} />{agentName(s.agent, names)}</>}</span><span>{s.what}</span></li>)}</ol>
        </section>
      ))}
      <section className="section">
        <h2>Règles ou modèle de langage ?</h2>
        <p className="section-note">Le partage est fixe. Si le fournisseur de modèle est indisponible, la revue, les métriques et les garde-fous continuent.</p>
        <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Travail</th><th scope="col">Réalisé par</th><th scope="col">Pourquoi</th></tr></thead>
          <tbody>{SPLIT.map(([a, b, c]) => <tr key={a}><th scope="row">{a}</th><td>{b}</td><td>{c}</td></tr>)}</tbody></table></div>
      </section>
      <section className="section">
        <h2>Niveaux d'autonomie</h2>
        <p className="section-note">L'autonomie se gagne par type d'action, jamais globalement. Dans cette version, aucune écriture n'a lieu sans votre approbation.</p>
        <div className="table-wrap"><table className="econ"><thead><tr><th scope="col">Action</th><th scope="col">Risque</th><th scope="col">Traitement</th></tr></thead>
          <tbody>{AUTONOMY.map(([a, b, c]) => <tr key={a}><th scope="row">{a}</th><td>{b === "interdit" ? <State role="veto">interdit</State> : b}</td><td>{c}</td></tr>)}</tbody></table></div>
      </section>
      <p className="foot">Aucune automatisation de navigateur n'est utilisée sur Airbnb ou Booking.com : les promotions passent par une procédure manuelle guidée tant que les accès partenaires officiels ne sont pas obtenus.</p>
    </Page>
  );
}

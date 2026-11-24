import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Term } from "@/components/Term";
import { Page } from "@/components/Page";
import { State } from "@/components/ui";
import { agentName, WORKFLOWS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { CYCLE } from "@/lib/engine/stateMachine";
import { PLAYBOOK_CODES, PLAYBOOKS } from "@/lib/engine/playbooks";
import { POLICY_RULES, POLICY_CODES } from "@/lib/engine/policy";
import { formatValue } from "@/lib/engine/signal-format";
import { CHANNEL_LABEL } from "@/lib/engine/types";
import { BASELINE_DAYS } from "@/lib/experiments/windows";
import { DILUTION_THRESHOLD, MIN_DELTA_NIGHTS, MIN_OBSERVATION_DAYS, MIN_RELATIVE_CHANGE, OUTCOME_LABEL, OUTCOMES } from "@/lib/experiments/outcome";
import { RULES_CHECKED_AT, STACK_STATUS, groupedRules } from "@/lib/stacking/rules";

export const metadata = { title: "Méthode de travail" };
const SPLIT: [string, string, string][] = [
  ["Calcul des planchers, cascade du revenu net, cumul des remises", "Règles déterministes", "Aucun modèle de langage ne décide si un prix est rentable."],
  ["Détection des signaux, dédoublonnage, classement de la file", "Règles déterministes", "Reproductible d'un jour à l'autre, testable."],
  ["Audit et veto, machine à états, droits", "Règles déterministes", "Un garde-fou ne se négocie pas."],
  ["Avis des stratèges sur leurs options, seconde lecture de l'auditeur", "Modèle de langage, sur faits certifiés", "Ils commentent ou alertent ; ils ne changent ni montant, ni option retenue, ni veto."],
  ["Synthèse des dossiers, réponses à vos questions, bilan mensuel", "Modèle de langage, sur faits certifiés", "Il explique ; il n'ajoute aucun chiffre et n'exécute rien."],
];
const AUTONOMY: [string, string, string][] = [
  ["Recommandation sans écriture", "faible", "Automatique"], ["Séjour minimum réduit pour combler un trou de 3 nuits au plus", "faible à moyen", "Sur votre approbation"],
  ["Prix daté dans ±5 %, 14 nuits au plus", "moyen", "Sur votre approbation"], ["Variation au-delà de ±5 % ou prix de base", "élevé", "Approbation commentée"],
  ["Promotion de canal jusqu'à 10 %", "moyen", "Approbation + procédure manuelle guidée"], ["Toute action sous le plancher absolu", "interdit", "Veto de l'auditeur"],
];

const DATA_LABEL: Record<string, string> = {
  RESERVATIONS: "réservations", AVAILABILITY: "disponibilités", PRICING: "prix", MARKET: "marché", PROMOTIONS: "promotions vérifiées",
  CONFIG: "configuration PriceLabs", ECONOMICS: "modèle économique", STRATEGY: "stratégie",
};
const APPROVER_LABEL: Record<string, string> = {
  REVENUE_MANAGER: "Votre validation", REVENUE_MANAGER_AND_OWNER: "Votre validation, avec commentaire", OPERATOR_AND_RM: "Votre validation, puis procédure manuelle dans l'extranet", NONE: "Aucune",
};

export default async function Methode() {
  const user = await requireUser();
  const names = user.settings.agentNames ?? null;
  return (
    <Page title="Méthode de travail" sub="Workflows, garde-fous et partage des rôles" crumbs={[{ label: "Agence IA" }, { label: "Méthode de travail" }]}>
      <div className="page-head">
        <h1>Comment travaille l'agence</h1>
        <p>La règle centrale : une occupation faible n'entraîne jamais automatiquement une baisse de prix. L'équipe établit d'abord un <Term id="diagnostic-causal">diagnostic causal</Term> — demande, fenêtre de réservation, prix, restriction, promotion, annonce — puis compare les options, dont celle de ne rien faire.</p>
        <p style={{ marginTop: 10 }}>Un mot vous échappe ? <Link href="/glossaire">Consultez le glossaire</Link> : chaque terme y est expliqué avec un exemple.</p>
      </div>
      <section className="section" style={{ marginTop: 0 }}>
        <h2>Le cycle d'une décision</h2>
        <p className="section-note">Huit étapes traçables. Les quatre premières sont faites par l'équipe avant que vous ne voyiez le dossier.</p>
        <ol className="frieze" role="list">{CYCLE.map((n, i) => <li key={n} className={i < 4 ? "is-fait" : i === 4 ? "is-encours" : "is-avenir"}><span className="fr-step"><span className="fr-glyph" /><span className="fr-no">{i + 1}/8</span></span><span className="fr-name">{n}</span><span className="fr-state">{i < 4 ? "équipe" : i === 4 ? "vous" : i === 5 ? "équipe ou vous" : "équipe"}</span></li>)}</ol>
      </section>
      {WORKFLOWS.map((w) => (
        <section className="section" key={w.id}>
          <h2>{w.name}</h2><p className="section-note">{w.cadence} · {w.purpose}</p>
          <ol className="flow">{w.steps.map((s, i) => <li key={i}><span className="n">{i + 1}</span><span className={`who${s.agent === "vous" ? " is-you" : ""}`}>{s.agent === "vous" ? "Vous" : <><Avatar agent={s.agent} size={24} />{agentName(s.agent, names)}</>}</span><span>{s.what}</span></li>)}</ol>
        </section>
      ))}
      <section className="section" aria-labelledby="playbooks-h" data-testid="playbooks">
        <h2 id="playbooks-h">Les playbooks de l'agence</h2>
        <p className="section-note">Chaque situation que l'agence sait reconnaître a un déclencheur chiffré, des données dont elle dépend, une période de repos après décision, un approbateur et une vérification. Ces seuils sont ceux que le moteur utilise.</p>
        <ul className="playbooks">
          {PLAYBOOK_CODES.map((c) => {
            const p = PLAYBOOKS[c];
            return (
              <li key={c} className="playbook">
                <details className="fold">
                  <summary><span className="mono">{p.code}</span> {p.label} {p.status === "PLANNED" && <State role="tech">pas encore actif</State>}</summary>
                  <div className="fold-body">
                    <p>{p.trigger}</p>
                    {Object.keys(p.thresholds).length > 0 && (
                      <div className="table-wrap"><table className="econ"><caption className="sr-only">Seuils du playbook {p.code}</caption>
                        <thead><tr><th scope="col">Seuil</th><th scope="col">Valeur</th></tr></thead>
                        <tbody>{Object.entries(p.thresholds).map(([k, th]) => <tr key={k}><th scope="row">{th.label}</th><td className="mono">{formatValue(th.value, th.unit)}</td></tr>)}</tbody></table></div>
                    )}
                    <dl className="playbook-facts">
                      <div><dt>Données nécessaires</dt><dd>{p.requiredData.map((d) => DATA_LABEL[d] ?? d).join(", ")}</dd></div>
                      <div><dt>Période de repos après décision</dt><dd>{p.cooldownDays} jour{p.cooldownDays > 1 ? "s" : ""}</dd></div>
                      <div><dt>Approbation</dt><dd>{APPROVER_LABEL[p.approver]}</dd></div>
                      <div><dt>Vérification</dt><dd>{p.verification}</dd></div>
                      <div><dt>Horizon de mesure</dt><dd>{p.measurementHorizonDays > 0 ? `${p.measurementHorizonDays} jours` : "sans objet"}</dd></div>
                      {p.vetoRules.length > 0 && <div><dt>Règles de l'auditeur concernées</dt><dd>{p.vetoRules.map((v) => `${POLICY_RULES[v]?.label ?? v} (${POLICY_RULES[v]?.onFail === "VETO" ? "veto" : "validation humaine"})`).join(", ")}</dd></div>}
                      {p.exclusions.length > 0 && <div><dt>Ce qui écarte l'action</dt><dd>{p.exclusions.join(" ; ")}</dd></div>}
                    </dl>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="section" aria-labelledby="auditeur-h" data-testid="regles-auditeur">
        <h2 id="auditeur-h">Les règles de l'auditeur</h2>
        <p className="section-note">Chaque option est contrôlée par des règles déterministes, chacune identifiée par un code (la seconde lecture par modèle, INDEPENDENT_REVIEW, est un ajout qui ne peut qu'alerter). Un <strong>veto</strong> rejette l'option : elle ne peut pas être approuvée. Une <strong>validation humaine</strong> la laisse proposée, mais elle ne s'approuve qu'avec un commentaire. Aucun modèle de langage n'intervient dans ces contrôles.</p>
        <ul className="playbooks">
          {POLICY_CODES.map((c) => {
            const r = POLICY_RULES[c];
            return (
              <li key={c} className="playbook">
                <details className="fold">
                  <summary><span className="mono">{r.code}</span> {r.label} {r.onFail === "VETO" ? <State role="veto">veto</State> : <State role="attention">validation humaine</State>}</summary>
                  <div className="fold-body">
                    <p>{r.checks}</p>
                    <dl className="playbook-facts">
                      <div><dt>Si la règle échoue</dt><dd>{r.onFail === "VETO" ? "L'option est rejetée (veto)." : "Aucun veto : cette règle ne rejette jamais seule."}</dd></div>
                      <div><dt>Si la règle alerte</dt><dd>{r.onWarn === "HUMAN" ? "Validation humaine avec commentaire." : "Sans objet."}</dd></div>
                      <div><dt>Seuil</dt><dd>{r.threshold}</dd></div>
                      <div><dt>Référence</dt><dd>{r.ref}</dd></div>
                    </dl>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </section>
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
      <section className="section" aria-labelledby="cumul-h">
        <h2 id="cumul-h">Règles de cumul des promotions</h2>
        <p className="section-note">Quand deux promotions d'un même canal valent pour les mêmes nuits, <Term id="regle-de-cumul">la règle de cumul</Term> décide du prix réel. L'agence ne la devine jamais : si l'aide officielle du canal ne la donne pas, l'auditeur renvoie l'option vers vous (validation commentée). Relecture des sources : {new Date(RULES_CHECKED_AT).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })}.</p>
        {(["BOOKING", "AIRBNB"] as const).map((ch) => (
          <div key={ch} className="stack-channel">
            <h3>{CHANNEL_LABEL[ch]}</h3>
            <ul className="rules stack-rules">
              {groupedRules(ch).map((g) => (
                <li key={g.status + g.detail}>
                  <State role={STACK_STATUS[g.status].role}>{STACK_STATUS[g.status].label}</State>
                  <div>
                    <span className="rule-detail">{g.detail}{g.source && <> <a href={g.source.url} target="_blank" rel="noopener noreferrer">Source officielle<span className="sr-only"> (nouvel onglet)</span></a></>}</span>
                    <details className="fold stack-pairs">
                      <summary>{g.pairs.length} combinaison{g.pairs.length > 1 ? "s" : ""}</summary>
                      <ul className="fold-body">{g.pairs.map(([a, b]) => <li key={a + b}>{a} + {b}</li>)}</ul>
                    </details>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <section className="section" aria-labelledby="mesure-h" data-testid="methode-mesure">
        <h2 id="mesure-h">Comment une action est mesurée</h2>
        <p className="section-note">Avant l'exécution, la <Term id="baseline">référence</Term> est figée : combien de nuits des dates visées se réservaient par jour pendant les {BASELINE_DAYS} jours précédents. Après la fenêtre d'observation, le rythme observé est comparé à ce que cette référence laissait attendre. Quatre résultats existent : {OUTCOMES.map((o) => OUTCOME_LABEL[o].toLowerCase()).join(", ")}.</p>
        <ul className="muted" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
          <li><strong>Positif</strong> ou <strong>négatif</strong> : au moins {MIN_DELTA_NIGHTS} nuits d'écart avec l'attendu et au moins {Math.round(MIN_RELATIVE_CHANGE * 100)} % d'écart relatif. Sinon, <strong>neutre</strong>.</li>
          <li><strong>Dilution</strong> : si les nuits en plus se vendent à un net par nuit plus bas de plus de {Math.round(DILUTION_THRESHOLD * 100)} %, le résultat reste neutre.</li>
          <li><strong>Non concluant</strong> (jamais deviné) : référence insuffisante ou absente, observation de moins de {MIN_OBSERVATION_DAYS} jours, réservations non synchronisées récemment (SuperHote, ou PriceLabs à défaut ; un logement sans aucune source reliée n'a pas de date de synchronisation à opposer), ou autre action sur les mêmes séjours observée en même temps.</li>
          <li>Aucune période témoin : un résultat positif décrit ce qui s'est passé après l'action, pas ce qu'elle a causé. L'<Term id="effet-incremental">effet incrémental</Term> reste inconnu.</li>
        </ul>
      </section>
      <p className="foot">Aucune automatisation de navigateur n'est utilisée sur Airbnb ou Booking.com : les promotions passent par une procédure manuelle guidée tant que les accès partenaires officiels ne sont pas obtenus.</p>
    </Page>
  );
}

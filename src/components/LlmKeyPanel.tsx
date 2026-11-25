import Link from "next/link";
import { refreshModelsAction, removeLlmKeyAction, saveLlmKeyAction } from "@/app/actions/llm";
import { ActionForm, Submit } from "@/components/forms";
import { Recap, State, Vq } from "@/components/ui";
import type { LlmStatus } from "@/lib/agents/llm-config";
import { PROVIDER_KEYS, PROVIDER_LABEL } from "@/lib/agents/owner-keys";
import { fmtDateTime } from "@/lib/dates";

const WHERE: Record<(typeof PROVIDER_KEYS)[number], { site: string; steps: [string, string] }> = {
  anthropic: { site: "console.anthropic.com", steps: ["Ouvrez <strong>API keys</strong>.", "Cliquez sur <strong>Create key</strong>, donnez-lui un nom, puis copiez-la."] },
  openai: { site: "platform.openai.com", steps: ["Ouvrez <strong>API keys</strong> dans les réglages du projet.", "Cliquez sur <strong>Create new secret key</strong>, puis copiez-la."] },
  mistral: { site: "console.mistral.ai", steps: ["Ouvrez <strong>API keys</strong>.", "Cliquez sur <strong>Create new key</strong>, puis copiez-la."] },
};

/**
 * Carte « Modèles de langage » : une clé API par fournisseur, saisie par le propriétaire (chiffrée, jamais réaffichée).
 * Le serveur ne détient aucune clé : les données d'un propriétaire ne partent que vers les fournisseurs pour lesquels il a saisi sa propre clé.
 */
export function LlmKeyPanel({ status }: { status: LlmStatus }) {
  const count = status.providers.length;
  return (
    <article className="stratum" id="llm-keys">
      <header>
        <h3>Modèles de langage</h3><span className="metric-source">Synthèses et conversations</span>
        <span style={{ marginLeft: "auto" }}><State role={count ? "sain" : "neutre"}>{count ? `${count} clé${count > 1 ? "s" : ""}` : "Non configuré"}</State></span>
      </header>
      <div className="stratum-body">
        <p className="muted" style={{ margin: "0 0 14px" }}>
          Vos données ne sont envoyées qu'aux fournisseurs pour lesquels vous saisissez <strong>votre propre clé</strong>. Le serveur n'en détient aucune : sans clé, la revue, les calculs et les garde-fous fonctionnent à l'identique en mode déterministe.
          Le routeur choisit ensuite, parmi vos fournisseurs, le modèle le moins cher qui convient à chaque tâche : prix, qualification, plafond de dépense et coûts sont dans l'<Link href="/modeles">écran Modèles</Link>.
        </p>
        {PROVIDER_KEYS.map((p, i) => {
          const k = status.providers.find((x) => x.provider === p), label = PROVIDER_LABEL[p];
          return (
            <section key={p} data-provider={p} style={{ marginTop: i ? 20 : 0, paddingTop: i ? 16 : 0, borderTop: i ? "1px solid var(--line, rgba(128,128,128,.25))" : undefined }} aria-label={`Clé ${label}`}>
              <h4 style={{ margin: "0 0 8px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>{label} <State role={k ? "sain" : "neutre"}>{k ? "Votre clé" : "Pas de clé"}</State></h4>
              <Recap rows={[
                ["Clé", k ? k.keyHint : <Vq>aucune</Vq>, true],
                ["Modèles disponibles", k ? String(k.models.length) : <Vq>saisissez votre clé pour les lister</Vq>, true],
                ["Dernière vérification", k?.verifiedAt ? fmtDateTime(k.verifiedAt) : <Vq>jamais</Vq>, true],
              ]} />
              <ActionForm action={saveLlmKeyAction} hidden={{ provider: p }} style={{ marginTop: 12 }}>
                <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
                  <label htmlFor={`llm-apiKey-${p}`}>{k ? `Remplacer ma clé API ${label}` : `Ma clé API ${label}`}</label>
                  <input id={`llm-apiKey-${p}`} name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={20} aria-describedby={`llm-apiKey-${p}-h`} />
                  <span className="help" id={`llm-apiKey-${p}-h`}>Vérifiée auprès de {label}, puis chiffrée. Jamais réaffichée en entier. La facturation des appels reste sur votre compte {label}.</span>
                </div>
                <Submit icon="plug" pendingLabel="Vérification de la clé…">{k ? "Vérifier et remplacer" : "Vérifier et enregistrer"}</Submit>
              </ActionForm>
              <details className="fold" style={{ marginTop: 10 }}>
                <summary>Où trouver ma clé API {label} ?</summary>
                <div className="fold-body">
                  <ol className="runbook">
                    <li>Connectez-vous à {WHERE[p].site}.</li>
                    {WHERE[p].steps.map((s, j) => <li key={j} dangerouslySetInnerHTML={{ __html: s }} />)}
                    <li>Collez-la dans le champ ci-dessus : elle n'est affichée qu'une fois par {label}.</li>
                  </ol>
                </div>
              </details>
              {k && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                  <ActionForm action={refreshModelsAction} hidden={{ provider: p }} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo" pendingLabel="Actualisation…">Actualiser les modèles</Submit></ActionForm>
                  <ActionForm action={removeLlmKeyAction} hidden={{ provider: p }} className="inline"><Submit className="btn btn-danger btn-sm" icon="ban" pendingLabel="Suppression…">Supprimer ma clé</Submit></ActionForm>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
}

import { refreshModelsAction, removeLlmKeyAction, saveLlmKeyAction } from "@/app/actions/llm";
import { ActionForm, Submit } from "@/components/forms";
import { Recap, State, Vq } from "@/components/ui";
import { serverDefaultModel } from "@/lib/agents/llm";
import type { LlmStatus } from "@/lib/agents/llm-config";
import { fmtDateTime } from "@/lib/dates";

/** Carte « Modèle de langage » : clé API du propriétaire (chiffrée, jamais réaffichée) et liste des modèles qu'elle ouvre. */
export function LlmKeyPanel({ status }: { status: LlmStatus }) {
  const own = status.source === "utilisateur";
  return (
    <article className="stratum">
      <header>
        <h3>Modèle de langage</h3><span className="metric-source">Synthèses et conversations</span>
        <span style={{ marginLeft: "auto" }}><State role={status.source === "aucune" ? "neutre" : "sain"}>{own ? "Votre clé" : status.source === "serveur" ? "Clé du serveur" : "Non configuré"}</State></span>
      </header>
      <div className="stratum-body">
        <Recap rows={[
          ["Fournisseur", "Anthropic"],
          ["Clé", own ? status.keyHint : status.source === "serveur" ? "clé partagée du serveur (repli)" : <Vq>aucune</Vq>, true],
          ["Modèles disponibles", own ? String(status.models.length) : <Vq>saisissez votre clé pour les lister</Vq>, true],
          ["Dernière vérification", status.verifiedAt ? fmtDateTime(status.verifiedAt) : <Vq>jamais</Vq>, true],
          ["Modèle par défaut", serverDefaultModel(), true],
          ["Repli en cas de panne", status.fallbackModel ? `OpenAI (${status.fallbackModel}), clé du serveur` : <Vq>aucun fournisseur de repli</Vq>],
          ["Sans clé", "Repli déterministe : la revue, les calculs et les garde-fous fonctionnent à l'identique."],
        ]} />
        <ActionForm action={saveLlmKeyAction} style={{ marginTop: 14 }}>
          <div className="field" style={{ marginBottom: 12, maxWidth: 560 }}>
            <label htmlFor="llm-apiKey">{own ? "Remplacer ma clé API Anthropic" : "Ma clé API Anthropic"}</label>
            <input id="llm-apiKey" name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={20} aria-describedby="llm-apiKey-h" />
            <span className="help" id="llm-apiKey-h">Vérifiée auprès d'Anthropic, puis chiffrée. Jamais réaffichée en entier. Les modèles proposés dans la liste dépendent de cette clé.</span>
          </div>
          <Submit icon="plug" pendingLabel="Vérification de la clé…">{own ? "Vérifier et remplacer" : "Vérifier et enregistrer"}</Submit>
        </ActionForm>
        <details className="fold" style={{ marginTop: 12 }}>
          <summary>Où trouver ma clé API Anthropic ?</summary>
          <div className="fold-body">
            <ol className="runbook">
              <li>Connectez-vous à la console Anthropic (console.anthropic.com), puis ouvrez <strong>API keys</strong>.</li>
              <li>Cliquez sur <strong>Create key</strong>, donnez-lui un nom, puis copiez-la : elle n'est affichée qu'une fois.</li>
              <li>Collez-la dans le champ ci-dessus. La facturation des appels reste sur votre compte Anthropic.</li>
            </ol>
          </div>
        </details>
        {own && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
            <ActionForm action={refreshModelsAction} className="inline"><Submit className="btn btn-ghost btn-sm" icon="undo" pendingLabel="Actualisation…">Actualiser les modèles</Submit></ActionForm>
            <ActionForm action={removeLlmKeyAction} className="inline"><Submit className="btn btn-danger btn-sm" icon="ban" pendingLabel="Suppression…">Supprimer ma clé</Submit></ActionForm>
          </div>
        )}
      </div>
    </article>
  );
}

import type { LlmModelInfo } from "@/lib/agents/llm";

/**
 * Liste déroulante des modèles que la clé du propriétaire peut utiliser. Jamais de saisie libre.
 * Un modèle déjà choisi mais retiré de la liste reste affiché (marqué) pour que le choix ne disparaisse pas en silence.
 */
export function AgentModelSelect({ id, name, models, current, defaultLabel, disabled }: { id: string; name: string; models: LlmModelInfo[]; current?: string | null; defaultLabel: string; disabled?: boolean }) {
  const known = models.some((m) => m.id === current);
  return (
    <select id={id} name={name} defaultValue={current ?? ""} disabled={disabled}>
      <option value="">{defaultLabel}</option>
      {current && !known && <option value={current}>{current} (plus disponible avec votre clé)</option>}
      {models.map((m) => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} (${m.id})`}</option>)}
    </select>
  );
}

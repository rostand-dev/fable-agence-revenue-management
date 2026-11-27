import { AGENT_BY_ID, avatarSrc, type AgentId } from "@/lib/agents/registry";

/* Portraits de l'équipe : un fichier par poste. Ils représentent un rôle, pas une personne réelle. */
export function Avatar({ agent, size = 76, title }: { agent: AgentId | string; size?: number; title?: string }) {
  const a = AGENT_BY_ID[agent as AgentId];
  if (!a) return null;
  // sans titre, l'image est décorative : le nom figure déjà à côté
  return <img className="avatar" src={avatarSrc(a.id)} width={size} height={size} alt={title ?? ""} decoding="async" />;
}

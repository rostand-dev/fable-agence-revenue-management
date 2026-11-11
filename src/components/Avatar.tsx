import { AGENT_BY_ID, type AgentId, type AvatarSpec } from "@/lib/agents/registry";

/* Avatars illustrés : un même gabarit, huit variations. Ils représentent un rôle, pas une personne réelle. */
function Hair({ s }: { s: AvatarSpec }) {
  const c = s.hair;
  switch (s.hairStyle) {
    case "bob": return <path fill={c} d="M27 50c-3-20 8-33 23-33s26 13 23 33c-1 6-3 10-5 12 1-10 0-19-6-25-7 4-18 5-26 2-4 6-4 14-3 23-3-2-5-6-6-12z" />;
    case "bun": return <g fill={c}><circle cx="50" cy="15" r="8" /><path d="M29 44c-1-16 8-26 21-26s22 10 21 26c-3-8-8-13-13-15-6 3-18 4-23 2-3 3-5 8-6 13z" /></g>;
    case "long": return <path fill={c} d="M26 78c-4-14-4-30-1-40 3-14 12-21 25-21s22 7 25 21c3 10 3 26-1 40-4-2-6-8-6-16V44c-4-5-7-9-9-12-8 4-18 5-26 3-3 4-4 8-4 13v14c0 8-1 14-3 16z" />;
    case "curly": return <g fill={c}><circle cx="34" cy="30" r="10" /><circle cx="46" cy="22" r="11" /><circle cx="60" cy="24" r="11" /><circle cx="69" cy="34" r="9" /><circle cx="29" cy="42" r="8" /><circle cx="72" cy="45" r="7" /></g>;
    case "wave": return <path fill={c} d="M29 42c-2-15 7-25 20-25 6 0 10 1 13 4 7 0 11 8 10 20-2-6-5-10-9-12-9 4-20 3-27 0-3 3-6 8-7 13z" />;
    case "short": return <path fill={c} d="M29 42c-2-14 7-24 21-24s23 10 21 24c-2-6-5-10-8-12-10 3-20 3-27 0-3 3-5 7-7 12z" />;
    case "crop": return <path fill={c} d="M30 40c-1-13 8-21 20-21s21 8 20 21c-2-5-5-8-8-10-9 2-17 2-25 0-3 2-5 5-7 10z" />;
    default: return <path fill={c} opacity=".9" d="M30 40c0-13 8-21 20-21s20 8 20 21c-3-7-9-12-20-12s-17 5-20 12z" />;
  }
}

export function Avatar({ agent, size = 76, title }: { agent: AgentId | string; size?: number; title?: string }) {
  const a = AGENT_BY_ID[agent as AgentId];
  if (!a) return null;
  const s = a.avatar, gid = "av-" + a.id;
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 100 100" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={s.bg[0]} /><stop offset="1" stopColor={s.bg[1]} /></linearGradient>
        <clipPath id={gid + "-c"}><circle cx="50" cy="50" r="50" /></clipPath>
      </defs>
      <g clipPath={`url(#${gid}-c)`}>
        <rect width="100" height="100" fill={`url(#${gid})`} />
        <circle cx="82" cy="16" r="1.2" fill="#fff" opacity=".5" /><circle cx="16" cy="24" r="1" fill="#c4b5fd" opacity=".6" /><circle cx="90" cy="52" r=".9" fill="#fff" opacity=".4" />
        <path fill={s.top} d="M14 104c1-20 14-30 36-30s35 10 36 30z" />
        <path fill="#000" opacity=".14" d="M38 76c4 6 20 6 24 0l-2 6c-6 4-14 4-20 0z" />
        <rect x="43" y="62" width="14" height="16" rx="6" fill={s.skin} />
        <ellipse cx="50" cy="45" rx="19" ry="22" fill={s.skin} />
        <Hair s={s} />
        {s.beard && <path fill={s.hair} opacity=".85" d="M33 52c2 12 9 17 17 17s15-5 17-17c-3 5-7 7-11 7-2-2-10-2-12 0-4 0-8-2-11-7z" />}
        <ellipse cx="42.5" cy="46" rx="1.9" ry="2.3" fill="#1c1917" /><ellipse cx="57.5" cy="46" rx="1.9" ry="2.3" fill="#1c1917" />
        <path d="M44 56.5c3.5 2.6 8.5 2.6 12 0" stroke="#1c1917" strokeOpacity=".65" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        {s.glasses && <g fill="none" stroke="#e2e8f0" strokeOpacity=".85" strokeWidth="1.4"><circle cx="42.5" cy="46" r="5.6" /><circle cx="57.5" cy="46" r="5.6" /><path d="M48.1 46h3.8" /></g>}
      </g>
    </svg>
  );
}

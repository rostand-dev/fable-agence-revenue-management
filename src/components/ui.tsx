import Link from "next/link";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { AGENT_BY_ID, agentName, type AgentId } from "@/lib/agents/registry";
import { euro } from "@/lib/format";
import type { StackResult } from "@/lib/engine/types";

type Role = "sain" | "attention" | "violation" | "veto" | "tech" | "neutre";
export function State({ role, children }: { role: Role; children: React.ReactNode }) {
  return <span className={`state state-${role}`}><span className="state-mark" />{children}</span>;
}
export function Badge({ family, icon, children }: { family: "prep" | "approb" | "applic" | "verif"; icon: string; children: React.ReactNode }) {
  return <span className={`badge badge-${family}`}><Icon name={icon} />{children}</span>;
}
export function Banner({ role, icon, title, children, style }: { role: "tech" | "sain" | "attention" | "violation" | "veto"; icon?: string; title: string; children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className={`banner banner-${role}`} role="status" style={style}>
      <Icon name={icon ?? (role === "sain" ? "check" : role === "tech" ? "info" : role === "veto" ? "ban" : "alert")} />
      <div><p className="banner-title">{title}</p>{children && <div className="banner-body">{children}</div>}</div>
    </div>
  );
}
export function Metric({ label, value, unit, source, tone }: { label: string; value: React.ReactNode; unit?: string; source: React.ReactNode; tone?: "sain" | "attention" | "veto" }) {
  return (
    <div className="metric od-stat">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${tone ? " is-" + tone : ""}`}>{value}{unit && <span className="unit"> {unit}</span>}</span>
      <span className="metric-source">{source}</span>
    </div>
  );
}
export function Vq({ kind = "inconnu", children }: { kind?: "inconnu" | "nonchiffrable" | "obsolete"; children: React.ReactNode }) {
  return <span className={`vq vq-${kind}`}>{children}</span>;
}
/** Montant ou qualificatif : une valeur absente n'est jamais affichée comme zéro. */
export function Money({ cents, precise }: { cents: number | null | undefined; precise?: boolean }) {
  return cents === null || cents === undefined ? <Vq>inconnu</Vq> : <>{euro(cents, precise)}</>;
}
export function Recap({ rows }: { rows: [string, React.ReactNode, boolean?][] }) {
  return <div className="recap">{rows.map(([k, v, mono], i) => <div key={i}><span className="k">{k}</span><p className={`v${mono ? " mono" : ""}`}>{v}</p></div>)}</div>;
}
export function Steps({ level, cls }: { level: number; cls: string }) {
  return <div className={`steps ${cls}`} aria-hidden="true">{[1, 2, 3, 4].map((i) => <span key={i} className={i <= level ? "on" : ""} />)}</div>;
}
export function confidenceScale(c: number): { level: number; label: string } {
  return c >= 0.8 ? { level: 4, label: "Élevée" } : c >= 0.65 ? { level: 3, label: "Bonne" } : c >= 0.45 ? { level: 2, label: "Modérée" } : { level: 1, label: "Faible" };
}
export function riskScale(r: string): { level: number; label: string; cls: string } {
  return r === "LOW" ? { level: 1, label: "Faible", cls: "faible" } : r === "MEDIUM" ? { level: 2, label: "Modéré", cls: "modere" } : r === "HIGH" ? { level: 3, label: "Élevé", cls: "eleve" } : { level: 4, label: "Critique", cls: "eleve" };
}
export function Byline({ agent, names, what }: { agent: string; names?: Record<string, string> | null; what?: string }) {
  const a = AGENT_BY_ID[agent as AgentId];
  if (!a) return null;
  return (
    <Link className="byline" href={`/equipe/${a.id}`} style={{ textDecoration: "none" }}>
      <Avatar agent={a.id} size={26} /><span><strong>{agentName(a.id, names)}</strong>{what === "" ? null : <> · {what ?? a.short}</>}</span>
    </Link>
  );
}
export function VerdictState({ verdict }: { verdict: string }) {
  return verdict === "APPROVE" ? <State role="sain">Conforme</State> : verdict === "REJECT" ? <State role="veto">Rejetée par l'auditeur</State> : <State role="attention">Validation commentée requise</State>;
}
export function OppStatus({ status, decision, actionStatus }: { status: string; decision?: string | null; actionStatus?: string | null }) {
  if (status === "OPEN") return <Badge family="prep" icon="clock">À arbitrer</Badge>;
  if (status === "DEFERRED") return <Badge family="prep" icon="clock">Différé</Badge>;
  if (status === "EXPIRED") return <Badge family="prep" icon="clock">Expiré</Badge>;
  if (decision === "REJECTED") return <Badge family="prep" icon="cross">Rejeté</Badge>;
  if (decision === "NO_ACTION") return <Badge family="approb" icon="pause">Inaction retenue</Badge>;
  if (actionStatus === "APPROVED") return <Badge family="approb" icon="check">Approuvé</Badge>;
  if (actionStatus === "EXECUTED" || actionStatus === "EXECUTING") return <Badge family="applic" icon="spin">Exécuté</Badge>;
  if (actionStatus === "VERIFIED" || actionStatus === "MEASURING") return <Badge family="verif" icon="search">En mesure</Badge>;
  if (actionStatus === "CLOSED") return <Badge family="verif" icon="check">Mesuré</Badge>;
  if (actionStatus === "ROLLED_BACK") return <Badge family="prep" icon="undo">Annulé</Badge>;
  if (actionStatus === "FAILED") return <Badge family="prep" icon="alert">Échec</Badge>;
  return <Badge family="approb" icon="check">Décidé</Badge>;
}

/** Cascade du revenu net : mêmes étapes sur les deux colonnes, du prix publié à la contribution. */
export function Cascade({ current, proposed }: { current: StackResult | null; proposed: StackResult | null }) {
  const ref = proposed ?? current;
  if (!ref) return null;
  const keyOf = (s: { key: string; label: string }, i: number) => (s.key === "promo" ? "promo:" + s.label : s.key);
  const rows: { k: string; label: string; src: string; kind?: string; a: number | null; p: number | null }[] = [];
  for (const [side, st] of [["a", current], ["p", proposed]] as const) {
    st?.steps.forEach((s, i) => {
      const k = keyOf(s, i); let r = rows.find((x) => x.k === k);
      if (!r) { r = { k, label: s.label, src: s.source, kind: s.kind, a: null, p: null }; rows.push(r); }
      r[side] = s.cents;
    });
  }
  const order = ["published", "promo", "gross", "commission", "fee", "net", "stay", "variable", "contribution"];
  rows.sort((x, y) => order.indexOf(x.k.split(":")[0]) - order.indexOf(y.k.split(":")[0]));
  const both = !!current && !!proposed;
  return (
    <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
      <table className="cascade">
        <caption className="visually-hidden">Cascade économique comparée, situation actuelle et option examinée</caption>
        <thead><tr><th scope="col">Étape</th>{current && <th scope="col" className="num">Actuel</th>}{proposed && <th scope="col" className="num">Proposé</th>}{both && <th scope="col" className="num">Écart</th>}</tr></thead>
        <tbody>
          {rows.map((r) => {
            const d = both && r.a !== null && r.p !== null ? r.p - r.a : null;
            const cell = (v: number | null, has: boolean) => has ? <td className="num">{v === null ? "—" : (v < 0 ? "−" : "") + euro(Math.abs(v))}</td> : null;
            return (
              <tr key={r.k} className={r.kind === "final" ? "step-final" : r.kind === "net" ? "step-net" : undefined}>
                <th scope="row">{r.label}<span className="src">{r.src}</span></th>
                {cell(r.a, !!current)}{cell(r.p, !!proposed)}
                {both && <td className={`num ${d !== null && d > 0 ? "delta-pos" : "delta-neu"}`}>{d === null ? "—" : (d > 0 ? "+" : d < 0 ? "−" : "") + euro(Math.abs(d))}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

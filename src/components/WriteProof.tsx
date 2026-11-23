import { fmtDateTime, fmtDay } from "@/lib/dates";
import { euro } from "@/lib/format";
import { Banner, Recap, State, Vq } from "@/components/ui";
import type { schema } from "@/db";

type Row = typeof schema.externalWrites.$inferSelect;
type Snap = { limits?: { minCents: number | null; baseCents: number | null; maxCents: number | null }; overrides?: Record<string, any>[] } | null;

const STATUS: Record<string, [string, "sain" | "attention" | "veto" | "neutre"]> = {
  CONFIRMED: ["Confirmée par relecture", "sain"], SENT: ["Envoyée, non confirmée", "attention"], FAILED: ["Refusée, rien modifié", "veto"], PENDING: ["En cours", "neutre"],
};
const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const val = (c: unknown) => (typeof c === "number" ? euro(c) : <Vq>inconnu</Vq>);
const ovOf = (s: Snap, date: string) => (Array.isArray(s?.overrides) ? s!.overrides!.find((o) => o?.date === date) : undefined);
const ovText = (o?: Record<string, any>) => {
  if (!o) return <Vq>aucun</Vq>;
  const n = Number(o.price);
  if (!Number.isFinite(n)) return <Vq>illisible</Vq>;
  return o.price_type === "percent" ? `variation de ${n} %` : o.price_type === "fixed" || o.price_type === undefined ? euro(Math.round(n * 100)) : <Vq>type inconnu</Vq>;
};
const Hash = ({ h }: { h: string | null }) => (h ? <code className="mono" title={h}>{h.slice(0, 12)}…<span className="sr-only"> (empreinte complète : {h})</span></code> : <>—</>);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

/** Preuve d'une écriture PriceLabs (US-092) : reçu de l'appel et état chez PriceLabs avant / après. Tolérant aux données mal formées : le panneau ne casse jamais la fiche. */
export function WriteProof({ writes }: { writes: Row[] }) {
  if (!writes.length) return null;
  return (
    <article className="stratum" data-testid="write-proof">
      <header><span className="st-no" aria-hidden="true">2b</span><h3>Preuve d'écriture chez PriceLabs</h3></header>
      <div className="stratum-body stack">
        {writes.map((w) => {
          const [label, role] = STATUS[w.status] ?? [w.status, "neutre" as const];
          const plan = isObj(w.plan) ? w.plan as { kind?: string; limits?: Record<string, number>; items?: { date: string; priceCents: number }[] } : {};
          // lignes créées avant l'US-092 : l'état d'avant se trouvait dans le plan
          const b = (isObj(w.stateBefore) ? w.stateBefore : isObj((plan as any).before) ? (plan as any).before : null) as Snap;
          const a = (isObj(w.stateAfter) ? w.stateAfter : null) as Snap;
          const rc = isObj(w.receipt) ? w.receipt as { method?: string; endpoint?: string; status?: number; sentAt?: string; requestHash?: string } : null;
          const sent = rc?.sentAt && !Number.isNaN(Date.parse(rc.sentAt)) ? fmtDateTime(new Date(rc.sentAt)) : null;
          const rows: [string, React.ReactNode, React.ReactNode][] = [];
          const noB = <Vq>avant non consigné</Vq>, noA = <Vq>non relu</Vq>;
          if (w.phase === "ROLLBACK") { /* pas de tableau : l'état relu est dans les empreintes ; les valeurs remises figurent dans l'exécution */ }
          else if (plan.kind === "LISTING_LIMITS" && isObj(plan.limits)) {
            for (const [k, t] of [["minCents", "Prix minimum"], ["baseCents", "Prix de base"], ["maxCents", "Prix maximum"]] as const)
              if (plan.limits[k] !== undefined) rows.push([t, b ? val(b.limits?.[k]) : noB, a ? val(a.limits?.[k]) : noA]);
          } else if (Array.isArray(plan.items)) for (const it of plan.items) if (isDate(it?.date)) rows.push([`Prix daté du ${fmtDay(it.date)}`, b ? ovText(ovOf(b, it.date)) : noB, a ? ovText(ovOf(a, it.date)) : noA]);
          return (
            <section key={w.id} className="stack" data-testid="write-proof-item" aria-label={`Écriture du ${fmtDateTime(w.createdAt)}`}>
              <Recap rows={[
                ["Écriture", <span key="s"><State role={role}>{label}</State>{w.phase === "ROLLBACK" && <span className="metric-source" style={{ display: "block", marginTop: 6 }}>Retour arrière ({w.kind === "OVERRIDES_DELETE" ? "prix daté supprimé" : w.kind === "OVERRIDES_RESTORE" ? "prix daté remis" : "valeurs d'avant remises"})</span>}</span>],
                ["Reçu de l'appel", rc?.method ? `${rc.method} ${rc.endpoint ?? "—"} → ${rc.status ?? "—"}` : <Vq>aucun (rien n'est parti ou réponse perdue)</Vq>],
                ["Envoyé le", sent ?? <Vq>—</Vq>, true],
                ["Empreinte de la requête", <Hash key="h" h={rc?.requestHash ?? null} />],
                ["Empreintes avant / après", <span key="e"><Hash h={w.stateBeforeHash} /> / <Hash h={w.stateAfterHash} /></span>],
                ["Source", w.adapter === "HTTP" ? "API PriceLabs" : `Jeu de test (${w.adapter})`],
              ]} />
              {w.error && <Banner role="attention" title="Détail">{w.error}</Banner>}
              {rows.length > 0 && (
                <div className="table-wrap"><table className="econ write-proof-table"><caption className="sr-only">État chez PriceLabs avant et après l'écriture</caption>
                  <thead><tr><th scope="col">Élément</th><th scope="col">Avant</th><th scope="col">Après</th></tr></thead>
                  <tbody>{rows.map(([t, x, y], i) => <tr key={i}><th scope="row">{t}</th><td className="mono">{x}</td><td className="mono">{y}</td></tr>)}</tbody>
                </table></div>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
}

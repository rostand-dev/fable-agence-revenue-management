import { gaugePositions, waterfallGeometry, type Axis } from "@/lib/engine/waterfall";
import type { StackResult } from "@/lib/engine/types";
import { euro } from "@/lib/format";

const signed = (c: number) => (c < 0 ? "−" : "") + euro(Math.abs(c));

/**
 * Cascade du revenu net en barres (US-083) : du prix publié à la contribution, une ligne par étape.
 * Une ligne = un libellé, un montant en toutes lettres et une barre décorative : le sens ne dépend jamais de la couleur seule.
 */
export function Waterfall({ title, result, axis }: { title: string; result: StackResult; axis?: Axis }) {
  const g = waterfallGeometry(result.steps, axis);
  return (
    <figure className="wf" data-testid="waterfall" aria-labelledby={`wf-${title.replace(/\W/g, "")}`}>
      <figcaption className="wf-title" id={`wf-${title.replace(/\W/g, "")}`}>{title}</figcaption>
      <ol className="wf-list" role="list">
        {g.rows.map((r) => (
          <li key={r.key + r.label} className={`wf-row wf-${r.kind}`}>
            <div className="wf-head"><span className="wf-label">{r.label}</span><span className="wf-amount">{(r.kind === "down" || r.kind === "up") && r.cents !== 0 ? (r.cents < 0 ? "−" : "+") + euro(Math.abs(r.cents)) : signed(r.cents)}</span></div>
            <div className="wf-track" aria-hidden="true">
              {g.zeroPct > 0.5 && g.zeroPct < 99.5 && <span className="wf-zero" style={{ left: `${g.zeroPct}%` }} />}
              <span className="wf-bar" style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }} />
            </div>
          </li>
        ))}
      </ol>
      {!g.closes && <p className="wf-warn" role="note">Cette cascade ne se referme pas sur la contribution annoncée : ne pas s'y fier.</p>}
    </figure>
  );
}

/** Prix vendu par nuit face aux deux planchers : la situation actuelle et l'option examinée sur un même axe. */
export function FloorGauge({ hardCents, strategyCents, soldBefore, soldAfter }: { hardCents: number; strategyCents: number; /** prix vendu par nuit, en centimes */ soldBefore: number | null; soldAfter: number | null }) {
  const values: Record<string, number> = { hard: hardCents, strategy: strategyCents };
  if (soldBefore !== null) values.current = soldBefore;
  if (soldAfter !== null) values.proposed = soldAfter;
  const { pos } = gaugePositions(values);
  const lo = Math.min(hardCents, strategyCents), hi = Math.max(hardCents, strategyCents);
  const verdict = (c: number | null) => (c === null ? null : c < lo ? "sous le plancher absolu" : c < hi ? "entre les deux planchers" : "au-dessus des deux planchers");
  return (
    <div className="fg" data-testid="floor-gauge">
      <p className="fg-title">Prix vendu par nuit face aux planchers</p>
      <div className="fg-track" aria-hidden="true">
        <span className="fg-zone fg-zone-red" style={{ left: 0, width: `${pos.hard}%` }} />
        <span className="fg-zone fg-zone-amber" style={{ left: `${pos.hard}%`, width: `${Math.max(pos.strategy - pos.hard, 0)}%` }} />
        <span className="fg-mark fg-mark-hard" style={{ left: `${pos.hard}%` }} />
        <span className="fg-mark fg-mark-strategy" style={{ left: `${pos.strategy}%` }} />
        {pos.current !== undefined && <span className="fg-dot fg-dot-current" style={{ left: `${pos.current}%` }} />}
        {pos.proposed !== undefined && <span className="fg-dot fg-dot-proposed" style={{ left: `${pos.proposed}%` }} />}
      </div>
      <ul className="fg-legend" role="list">
        <li><span className="fg-key fg-key-hard" />Plancher absolu : <strong>{euro(hardCents)}</strong></li>
        <li><span className="fg-key fg-key-strategy" />Plancher stratégique : <strong>{euro(strategyCents)}</strong></li>
        {soldBefore !== null && <li><span className="fg-key fg-key-current" />Actuel : <strong>{euro(soldBefore)}</strong> — {verdict(soldBefore)}</li>}
        {soldAfter !== null && <li><span className="fg-key fg-key-proposed" />Proposé : <strong>{euro(soldAfter)}</strong> — {verdict(soldAfter)}</li>}
      </ul>
    </div>
  );
}

/** Promotions empilées : ordre d'application, montant restant, cumul face au plafond de la stratégie. */
export function PromoStack({ result, capPct }: { result: StackResult | null; /** null : la stratégie ne fixe aucun plafond connu */ capPct: number | null }) {
  const promos = result?.steps.filter((s) => s.key === "promo") ?? [];
  if (!result) return null;
  const cum = result.cumulativeDiscountPct;
  return (
    <div className="ps" data-testid="promo-stack">
      <p className="fg-title">Promotions empilées</p>
      {promos.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucune promotion appliquée dans cette option.</p> : (
        <>
          <ol className="ps-list" role="list">{promos.map((s, i) => <li key={i}><span className="ps-n">{i + 1}</span><span className="ps-l">{s.label}<span className="src">{s.source}</span></span><span className="ps-a">{signed(s.cents)}</span></li>)}</ol>
          <p className="ps-sum">Remise cumulée : <strong>{(Math.round(cum * 10) / 10).toString().replace(".", ",")} %</strong> {capPct === null ? "— plafond de la stratégie non renseigné, aucun verdict." : <>pour un plafond de <strong>{capPct} %</strong> — {cum > capPct ? "plafond dépassé" : "dans le plafond"}.</>}</p>
        </>
      )}
    </div>
  );
}

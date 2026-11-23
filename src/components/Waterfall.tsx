import { gaugePositions, waterfallGeometry } from "@/lib/engine/waterfall";
import type { StackResult } from "@/lib/engine/types";
import { euro } from "@/lib/format";

const signed = (c: number) => (c < 0 ? "−" : "") + euro(Math.abs(c));

/**
 * Cascade du revenu net en barres (US-083) : du prix publié à la contribution, une ligne par étape.
 * Une ligne = un libellé, un montant en toutes lettres et une barre décorative : le sens ne dépend jamais de la couleur seule.
 */
export function Waterfall({ title, result }: { title: string; result: StackResult }) {
  const g = waterfallGeometry(result.steps);
  return (
    <figure className="wf" data-testid="waterfall" aria-label={title}>
      <figcaption className="wf-title">{title}</figcaption>
      <ol className="wf-list">
        {g.rows.map((r) => (
          <li key={r.key + r.label} className={`wf-row wf-${r.kind}`}>
            <div className="wf-head"><span className="wf-label">{r.label}</span><span className="wf-amount">{r.kind === "down" || r.kind === "up" ? (r.cents < 0 ? "−" : "+") + euro(Math.abs(r.cents)) : signed(r.cents)}</span></div>
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
export function FloorGauge({ hardCents, strategyCents, currentCents, proposedCents }: { hardCents: number; strategyCents: number; currentCents: number | null; proposedCents: number | null }) {
  const values: Record<string, number> = { hard: hardCents, strategy: strategyCents };
  if (currentCents !== null) values.current = currentCents;
  if (proposedCents !== null) values.proposed = proposedCents;
  const { pos } = gaugePositions(values);
  const verdict = (c: number | null) => (c === null ? null : c < hardCents ? "sous le plancher absolu" : c < strategyCents ? "entre les deux planchers" : "au-dessus des deux planchers");
  return (
    <div className="fg" data-testid="floor-gauge">
      <p className="fg-title">Prix vendu par nuit face aux planchers</p>
      <div className="fg-track" aria-hidden="true">
        <span className="fg-zone fg-zone-red" style={{ left: 0, width: `${pos.hard}%` }} />
        <span className="fg-zone fg-zone-amber" style={{ left: `${pos.hard}%`, width: `${pos.strategy - pos.hard}%` }} />
        <span className="fg-mark fg-mark-hard" style={{ left: `${pos.hard}%` }} />
        <span className="fg-mark fg-mark-strategy" style={{ left: `${pos.strategy}%` }} />
        {pos.current !== undefined && <span className="fg-dot fg-dot-current" style={{ left: `${pos.current}%` }} />}
        {pos.proposed !== undefined && <span className="fg-dot fg-dot-proposed" style={{ left: `${pos.proposed}%` }} />}
      </div>
      <ul className="fg-legend">
        <li><span className="fg-key fg-key-hard" />Plancher absolu : <strong>{euro(hardCents)}</strong></li>
        <li><span className="fg-key fg-key-strategy" />Plancher stratégique : <strong>{euro(strategyCents)}</strong></li>
        {currentCents !== null && <li><span className="fg-key fg-key-current" />Actuel : <strong>{euro(currentCents)}</strong> — {verdict(currentCents)}</li>}
        {proposedCents !== null && <li><span className="fg-key fg-key-proposed" />Proposé : <strong>{euro(proposedCents)}</strong> — {verdict(proposedCents)}</li>}
      </ul>
    </div>
  );
}

/** Promotions empilées : ordre d'application, montant restant, cumul face au plafond de la stratégie. */
export function PromoStack({ result, capPct }: { result: StackResult | null; capPct: number }) {
  const promos = result?.steps.filter((s) => s.key === "promo") ?? [];
  if (!result) return null;
  const cum = result.cumulativeDiscountPct;
  return (
    <div className="ps" data-testid="promo-stack">
      <p className="fg-title">Promotions empilées</p>
      {promos.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucune promotion appliquée dans cette option.</p> : (
        <>
          <ol className="ps-list">{promos.map((s, i) => <li key={i}><span className="ps-n">{i + 1}</span><span className="ps-l">{s.label}<span className="src">{s.source}</span></span><span className="ps-a">{signed(s.cents)}</span></li>)}</ol>
          <p className="ps-sum">Remise cumulée : <strong>{(Math.round(cum * 10) / 10).toString().replace(".", ",")} %</strong> pour un plafond de <strong>{capPct} %</strong> — {cum > capPct ? "plafond dépassé" : "dans le plafond"}.</p>
        </>
      )}
    </div>
  );
}

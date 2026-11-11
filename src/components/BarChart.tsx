import { euro } from "@/lib/format";

/** Barres mensuelles, série unique : une seule teinte, extrémités arrondies, valeur au survol et tableau équivalent. */
export function BarChart({ data, title, unit }: { data: { label: string; full: string; cents: number; note?: string }[]; title: string; unit: string }) {
  const W = 720, H = 220, L = 68, B = 26, T = 12;
  const max = Math.max(...data.map((d) => d.cents), 1);
  const step = Math.pow(10, Math.floor(Math.log10(max / 100))) * 100;
  const top = Math.ceil(max / step) * step;
  const ticks = [0, top / 2, top];
  const bw = (W - L - 8) / data.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  return (
    <div className="figure">
      <div className="figure-read"><h3>{title}</h3></div>
      <div className="figure-plot">
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {ticks.map((t) => <g key={t}><line className="grid" x1={L} x2={W} y1={y(t)} y2={y(t)} /><text x={L - 8} y={y(t) + 4} textAnchor="end">{euro(t)}</text></g>)}
          {data.map((d, i) => {
            const h = Math.max(1, y(0) - y(d.cents)), x = L + i * bw + 4, w = Math.min(34, bw - 8), r = Math.min(4, h);
            const cx = x + (bw - 8 - w) / 2;
            return (
              <g key={d.label + i}>
                <path fill="var(--blue)" d={`M${cx} ${y(0)}V${y(0) - h + r}a${r} ${r} 0 0 1 ${r}-${r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y(0)}z`}><title>{`${d.full} : ${euro(d.cents)}${d.note ? " · " + d.note : ""}`}</title></path>
                <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent"><title>{`${d.full} : ${euro(d.cents)}${d.note ? " · " + d.note : ""}`}</title></rect>
                <text x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle">{d.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="figure-units">{unit}</p>
      <details className="fold" style={{ margin: "0 18px 16px" }}>
        <summary>Voir les valeurs en tableau</summary>
        <div className="fold-body table-wrap" style={{ border: 0 }}>
          <table className="econ" style={{ minWidth: 0 }}><thead><tr><th scope="col">Mois</th><th scope="col" className="num">Valeur</th><th scope="col">Précision</th></tr></thead>
            <tbody>{data.map((d, i) => <tr key={i}><th scope="row">{d.full}</th><td className="num">{euro(d.cents)}</td><td>{d.note ?? ""}</td></tr>)}</tbody></table>
        </div>
      </details>
    </div>
  );
}

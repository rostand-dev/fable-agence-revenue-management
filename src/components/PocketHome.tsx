import Link from "next/link";
import { Banner, State } from "./ui";
import { fmtDay, fmtMonth } from "@/lib/dates";
import { TREND_KEYS, TREND_NAME, trendLabel, trendMonths, type MonthTrend, type TrendDirection } from "@/lib/metrics/trend";
import { PROPERTY_STATUS } from "@/lib/labels";
import type { PortfolioSummary } from "@/lib/portfolio-summary";
import type { OppWithAction } from "@/lib/queries";
import { situationRole } from "@/lib/situation";
import type { Candidate } from "@/lib/engine/types";

const ARROW: Record<TrendDirection, string> = { UP: "↗", STABLE: "→", DOWN: "↘", UNKNOWN: "?" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
/** « novembre 2026 » → « novembre » */
const monthName = (key: string) => fmtMonth(key).split(" ")[0];

function Trends({ t }: { t: MonthTrend }) {
  const reasons = [...new Set(TREND_KEYS.map((k) => t[k].reason).filter((r): r is string => !!r))];
  return (
    <>
      <span className="pk-trends">
        {TREND_KEYS.map((k) => (
          <span key={k} className={`pk-trend is-${t[k].direction.toLowerCase()}`} data-trend={k}>
            <span className="pk-trend-name">{TREND_NAME[k]}</span>
            <span className="pk-trend-value"><span aria-hidden="true">{ARROW[t[k].direction]} </span>{trendLabel(k, t[k].direction)}</span>
          </span>
        ))}
      </span>
      {reasons.length > 0 && <span className="pk-trend-why">Inconnu : {reasons.join(" · ")}</span>}
    </>
  );
}

/** Accueil du mode poche : l'état du portefeuille en un écran. Les chiffres détaillés et les connexions restent à la version complète. */
export function PocketHome({ summary: s, priority, trends, alerts, today, kill, capped }: {
  summary: PortfolioSummary;
  /** première situation ouverte, dans l'ordre de la boîte d'opportunités */
  priority: OppWithAction | null;
  trends: Map<string, MonthTrend>; alerts: number; today: string; kill: boolean; capped: boolean;
}) {
  const { month, previousMonth } = trendMonths(today);
  const pending = s.actions.toExecute + s.actions.toVerify, failed = s.actions.failed;
  const counters = [
    { key: "decider", label: "À décider", value: s.open, href: "/" },
    { key: "veto", label: "Sous veto", value: s.vetoes, href: "/?u=veto" },
    { key: "urgent", label: "Urgents", value: s.urgent, href: "/?u=urgent" },
  ];
  const cand = priority ? (priority.candidates as Candidate[])[priority.selected] : null;
  const tag = priority && cand ? situationRole(priority, cand) : null;
  return (
    <div className="pk-screen">
      {kill && <Banner role="attention" title="Coupe-circuit actif">L'écriture automatique par API est bloquée sur au moins une intégration. <Link href="/integrations">Voir les intégrations</Link></Banner>}
      {capped && <Banner role="tech" title="Portefeuille volumineux">Les listes sont limitées à 200 dossiers : les totaux peuvent être partiels.</Banner>}
      <div className="pk-state">
        <h1>{s.open === 0 ? "Rien à arbitrer" : `${plural(s.open, "situation")} à arbitrer`}</h1>
        <p data-testid="pk-etat">
          {s.vetoes > 0 && <>dont {s.vetoes} sous veto · </>}
          {alerts > 0 ? <Link href="/alertes">{plural(alerts, "alerte")} d'exécution</Link> : "aucune alerte d'exécution"}
        </p>
      </div>
      <div className="pk-counters" data-testid="pf-decider">
        {counters.map((c) => (
          <Link key={c.key} href={c.href} className={`pk-counter is-${c.key}${c.value > 0 ? " is-on" : ""}`}>
            <span className="pk-counter-label">{c.label}</span><span className="pk-counter-value">{c.value}</span>
          </Link>
        ))}
      </div>
      {pending + failed > 0 && (
        <Link href="/?f=traitees" className={`pk-actions-line${failed > 0 ? " is-failed" : ""}`} data-testid="pk-actions">
          <span>{[pending > 0 && `${plural(pending, "action")} à exécuter ou vérifier`, failed > 0 && (pending > 0 ? `${failed} en échec` : `${plural(failed, "action")} en échec`)].filter(Boolean).join(" · ")}</span>
          <span aria-hidden="true">›</span>
        </Link>
      )}
      {priority && tag && (
        <Link href={`/dossier/${priority.code}`} className={`pk-priority${priority.veto ? " is-veto" : ""}`} data-testid="pk-priorite">
          <span className="pk-sit-top"><State role={tag.role}>{tag.label}</State><span className="pk-sit-ref">Priorité #1</span></span>
          <span className="pk-priority-title">{priority.title}</span>
          <span className="pk-priority-asset">{s.rows.find((r) => r.id === priority.propertyId)?.name} · {fmtDay(priority.stayFrom)} → {fmtDay(priority.stayTo)}</span>
        </Link>
      )}
      <section aria-labelledby="pk-logements-h">
        <h2 id="pk-logements-h" className="pk-section-title">Vos logements · {monthName(month)}</h2>
        <ul className="pk-props" data-testid="pf-logements">
          {s.rows.map((r) => {
            const t = trends.get(r.id);
            return (
              <li key={r.id}>
                <Link href={`/logements/${r.id}`} className="pk-prop" data-testid="pk-logement">
                  <span className="pk-prop-head">
                    <span className="pk-prop-name">{r.name}</span>
                    <span className={`pk-prop-open${r.vetoes > 0 ? " is-veto" : ""}`}>{r.open > 0 ? `${r.open} à arbitrer` : "rien à arbitrer"} <span aria-hidden="true">›</span></span>
                  </span>
                  {(r.isDemo || r.status !== "ACTIVE") && <span className="pk-prop-meta">{[r.status !== "ACTIVE" && (PROPERTY_STATUS[r.status] ?? PROPERTY_STATUS.ONBOARDING)[0], r.isDemo && "démonstration"].filter(Boolean).join(" · ")}</span>}
                  {t && <Trends t={t} />}
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="pk-note">Tendance : {monthName(month)} (nuits réservées à ce jour) comparé à {monthName(previousMonth)}. Stable : variation de 5 % au plus.</p>
      </section>
    </div>
  );
}

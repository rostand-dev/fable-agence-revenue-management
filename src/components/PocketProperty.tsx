import Link from "next/link";
import { Icon } from "./Icon";
import { TodoCard, type TodoItem } from "./TodoCard";
import { Banner } from "./ui";
import { addDays, dow, fmtDate, fmtDay, type ISODate } from "@/lib/dates";
import { euro, insecable, pct } from "@/lib/format";
import { PROPERTY_STATUS } from "@/lib/labels";
import { monthName, TREND_ARROW, TREND_KEYS, TREND_NAME, trendLabel, type MonthTrend, type MonthValues, type TrendKey } from "@/lib/metrics/trend";
import { sectionHref } from "@/lib/nav";
import { freeNightsPhrase, NEXT_LINKS, type NextNight, type NextSituation } from "@/lib/next-nights";
import type { ChannelMarkup } from "@/lib/pricing/published";

const WEEKDAY = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const STATE_WORD: Record<NextNight["state"], string> = { FREE: "libre", BOOKED: "réservé", BLOCKED: "bloqué", UNKNOWN: "?" };
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
/** Signe de la légende entre guillemets, insécable. */
const mark = (sign: string) => `«\u00a0${sign}\u00a0»\u00a0:`;
/** « 28 nov. » porte déjà son point, « 3 mars » non. */
const sentenceEnd = (text: string) => (text.endsWith(".") ? text : `${text}.`);

type Property = { id: string; name: string; status: string; isDemo: boolean; strategyVersion: number };

/** En-tête de la fiche de poche : retour, nom, état et nombre de situations à arbitrer. */
export function PocketPropertyHeader({ p, open, vetoes }: { p: Property; open: number; vetoes: number }) {
  const status = (PROPERTY_STATUS[p.status] ?? PROPERTY_STATUS.ONBOARDING)[0];
  return (
    <header className="topbar pk-topbar pk-prop-top">
      <Link href="/logements" className="btn btn-ghost pk-back" aria-label="Retour aux logements"><Icon name="back" /></Link>
      <div>
        <h1 className="topbar-title">{p.name || "Logement sans nom"}</h1>
        <p className="topbar-sub">{[status, `stratégie v${p.strategyVersion}`, p.isDemo && "démo"].filter(Boolean).join(" · ")}</p>
      </div>
      <div className="pk-head-pill">
        {open > 0
          ? <Link href={`/?p=${p.id}`} className={`pk-arbitrer${vetoes > 0 ? " is-veto" : ""}`} data-testid="pk-arbitrer">{open} à arbitrer{vetoes > 0 && <span className="sr-only"> dont {vetoes} sous veto</span>} <span aria-hidden="true">›</span></Link>
          : <span className="pk-arbitrer is-none" data-testid="pk-arbitrer">rien à arbitrer</span>}
      </div>
    </header>
  );
}

function monthText(key: TrendKey, values: MonthValues): string {
  const v = values[key].value;
  if (v === null) return key === "occupancy" ? "inconnue" : "inconnu";
  return insecable(key === "occupancy" ? pct(v) : euro(v));
}

function Month({ trend, values }: { trend: MonthTrend; values: MonthValues }) {
  const label: Record<TrendKey, string> = { revenue: "Revenu net", occupancy: "Occupation", price: "Prix moyen net" };
  const absent = [...new Set(TREND_KEYS.map((k) => values[k].reason).filter((r): r is string => !!r))];
  // un motif déjà donné pour une valeur n'est pas répété pour sa tendance
  const noTrend = [...new Set(TREND_KEYS.map((k) => trend[k].reason).filter((r): r is string => !!r && !absent.includes(r)))];
  return (
    <section aria-labelledby="pk-mois-h">
      <h2 id="pk-mois-h" className="pk-section-title">{capital(monthName(trend.month))} · réservé à ce jour · vs {monthName(trend.previousMonth)}</h2>
      <div className="pk-card pk-month" data-testid="pk-mois">
        {TREND_KEYS.map((k) => (
          <div key={k} className={`pk-trend is-${trend[k].direction.toLowerCase()}`} data-trend={k}>
            <span className="pk-trend-name">{label[k]}</span>
            <span className={`pk-month-value${values[k].value === null ? " is-unknown" : ""}`}>{monthText(k, values)}</span>
            <span className="pk-trend-value" title={`Tendance : ${TREND_NAME[k]}`}><span aria-hidden="true">{TREND_ARROW[trend[k].direction]} </span>{trend[k].direction === "UNKNOWN" ? `tendance ${trendLabel("occupancy", "UNKNOWN")}` : trendLabel(k, trend[k].direction)}</span>
          </div>
        ))}
      </div>
      {absent.length > 0 && <p className="pk-note" data-testid="pk-mois-absent">Valeur inconnue : {absent.join(" · ")}.</p>}
      {noTrend.length > 0 && <p className="pk-note" data-testid="pk-mois-sans-tendance">Tendance inconnue : {noTrend.join(" · ")}.</p>}
    </section>
  );
}

function Nights({ propertyId, nights, situations, channel, readOn }: { propertyId: string; nights: NextNight[]; situations: NextSituation[]; channel: ChannelMarkup | null; readOn: ISODate | null }) {
  const shown = situations.slice(0, NEXT_LINKS);
  // la légende ne cite que les signes présents dans la grille
  const legend = [
    nights.some((n) => n.state === "UNKNOWN") && `${mark("?")} non lu`,
    nights.some((n) => n.flag === "open") && `${mark("•")} situation ouverte`,
    nights.some((n) => n.flag === "veto") && `${mark("!")} sous veto`,
  ].filter((x): x is string => !!x);
  return (
    <>
      <ol className="pk-nights" data-testid="pk-nuits">
        {nights.map((n) => (
          <li key={n.date} className={`pk-night is-${n.state.toLowerCase()}${n.flag ? ` is-${n.flag}` : ""}`} data-date={n.date} data-state={n.state}>
            <span className="pk-night-week" aria-hidden="true">{WEEKDAY[dow(n.date)]}</span>
            <span className="pk-night-day"><span aria-hidden="true">{Number(n.date.slice(8))}</span><span className="sr-only">{fmtDate(n.date)}</span>{n.flag && <span className="pk-night-mark" aria-hidden="true">{n.flag === "veto" ? "!" : "•"}</span>}</span>
            <span className="pk-night-price">{n.state !== "FREE" ? "" : n.priceCents === null ? <><span aria-hidden="true">?</span><span className="sr-only">prix inconnu</span></> : `${channel ? "~" : ""}${insecable(euro(n.priceCents))}`}</span>
            <span className="pk-night-state">{n.state === "UNKNOWN" ? <><span aria-hidden="true">?</span><span className="sr-only">nuit non lue</span></> : STATE_WORD[n.state]}</span>
            {n.flag && <span className="sr-only">{n.flag === "veto" ? "situation sous veto" : "situation ouverte"}</span>}
          </li>
        ))}
      </ol>
      <p className="pk-note" data-testid="pk-nuits-note">
        {channel ? `${mark("~")} prix estimé sur ${channel.label}.` : "Prix SuperHote, avant majoration."}
        {legend.length > 0 && ` ${legend.join(" · ")}.`}
        {readOn && ` Calendrier lu le ${sentenceEnd(fmtDay(readOn).replaceAll(" ", "\u00a0"))}`}
      </p>
      {shown.length > 0 && (
        <ul className="pk-night-links" data-testid="pk-nuits-situations">
          {shown.map((s) => (
            <li key={s.code}>
              <Link href={`/dossier/${s.code}`} className={`pk-night-link${s.veto ? " is-veto" : ""}`}>
                <span><strong>{freeNightsPhrase(s.nights)} : {s.veto ? "situation sous veto" : "situation ouverte"}</strong><span className="pk-night-title">{s.title}</span></span>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
          {situations.length > shown.length && <li><Link href={`/?p=${propertyId}`} className="pk-night-link"><span>Voir toutes les situations du logement</span><span aria-hidden="true">›</span></Link></li>}
        </ul>
      )}
    </>
  );
}

export type PocketLine = { key: string; label: string; value: string; href: string; attention?: boolean };

/**
 * Fiche d'un logement en mode poche : le mois en cours, les quatorze prochains jours et une ligne d'état par rubrique.
 * Les écrans de saisie restent à la version complète (encart « sur ordinateur »).
 */
export function PocketProperty({ p, today, trend, values, calendar, todo, lines, onboarding, canManage, canDelete, launched }: {
  p: Property; today: ISODate; trend: MonthTrend; values: MonthValues;
  /** null : aucun calendrier lu */
  calendar: { nights: NextNight[]; situations: NextSituation[]; channel: ChannelMarkup | null; readOn: ISODate | null } | null;
  todo: TodoItem[]; lines: PocketLine[]; onboarding: boolean; canManage: boolean; canDelete: boolean; /** « Observation lancée » */ launched: boolean;
}) {
  return (
    <div className="pk-screen pk-property" data-testid="fiche-poche">
      {onboarding && (
        <Banner role="tech" title="Création du logement en cours">
          Ce logement n'est pas encore lancé.
          {(canManage || canDelete) && <span className="pk-banner-actions">{canManage && <Link className="btn btn-primary btn-sm" href={`/logements/${p.id}/creation`}><Icon name="arrow" />Reprendre la création</Link>}{canDelete && <Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/supprimer`}><Icon name="cross" />Supprimer ce brouillon</Link>}</span>}
        </Banner>
      )}
      {launched && <Banner role="sain" title="Observation lancée">Le dossier est complet : l'équipe lit vos données et vous proposera ses premières situations, sans rien appliquer sans votre accord.</Banner>}
      <TodoCard items={todo} open={false} />
      <Month trend={trend} values={values} />
      <section aria-labelledby="pk-nuits-h">
        <h2 id="pk-nuits-h" className="pk-section-title">14 prochains jours<span className="sr-only"> : du {fmtDate(today)} au {fmtDate(addDays(today, 13))}</span></h2>
        {calendar ? <Nights propertyId={p.id} {...calendar} /> : <p className="pk-card pk-empty" data-testid="pk-sans-calendrier">Aucun calendrier lu. Il apparaît dès que les intégrations sont connectées.</p>}
      </section>
      <nav aria-label="Rubriques du logement">
        <ul className="pk-lines" data-testid="pk-rubriques">
          {lines.map((l) => (
            <li key={l.key}>
              <Link href={l.href} className={`pk-line${l.attention ? " is-attention" : ""}`} data-line={l.key}>
                <span className="pk-line-label">{l.label}</span><span className="pk-line-value">{l.value}</span><span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** Lignes d'état de la fiche de poche, dans l'ordre d'affichage. */
export function pocketLines(p: Property & { strategyDraft: unknown }, facts: { missing: number; failed: string[]; calendarEnd: ISODate | null }): PocketLine[] {
  const strategy = p.status === "ONBOARDING" ? "après la création" : `v${p.strategyVersion} active${p.strategyDraft ? " · brouillon en cours" : ""}`;
  const data = facts.failed.length ? `${facts.failed.join(" et ")} : lecture en échec` : facts.calendarEnd ? `calendrier lu jusqu'au ${fmtDate(facts.calendarEnd)}` : "aucun calendrier lu";
  return [
    { key: "strategie", label: "Stratégie", value: strategy, href: sectionHref(p.id, "strategie"), attention: !!p.strategyDraft && p.status !== "ONBOARDING" },
    { key: "donnees", label: "Données", value: data, href: sectionHref(p.id, "donnees"), attention: facts.failed.length > 0 },
    { key: "economie", label: "Économie et réglages", value: facts.missing ? `${plural(facts.missing, "donnée manquante", "données manquantes")} · sur ordinateur` : "sur ordinateur", href: sectionHref(p.id, "economie"), attention: facts.missing > 0 },
    { key: "performance", label: "Revenu mensuel et rythme", value: "12 mois", href: `/logements/${p.id}?tab=performance` },
    { key: "historique", label: "Historique du logement", value: "", href: sectionHref(p.id, "historique") },
  ];
}

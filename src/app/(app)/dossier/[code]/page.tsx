import { formatMeasure } from "@/lib/engine/signal-format";
import type { SignalMeasure } from "@/lib/engine/types";
import Link from "next/link";
import { Term } from "@/components/Term";
import { notFound } from "next/navigation";
import { and, asc, eq, ne } from "drizzle-orm";
import { AgentChat } from "@/components/AgentChat";
import { canVerifyManual, REREAD_MIN_HOURS } from "@/lib/promotions/lifecycle";
import { approveAction, deferAction, executeAction, rejectAction, reopenAction, rollbackAction, verifyAction } from "@/app/actions/decisions";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { needsComment } from "@/components/SitCard";
import { deterministicAnalysis, type MarketAnalysis } from "@/lib/agents/market-analysis";
import type { IndependentReview } from "@/lib/agents/independent-review";
import { deterministicOpinions, STANCE_LABEL, type AgentOpinion, type StrategistId } from "@/lib/agents/strategist-opinions";
import { Banner, Byline, Cascade, confidenceScale, Money, OppStatus, Recap, riskScale, State, VerdictState, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtDateTime, fmtDay, fmtPeriod } from "@/lib/dates";
import { hardFloorCents, strategyFloorCents } from "@/lib/engine/economics";
import { cooldownDaysOf, cooldownLabel, endOfCooldown } from "@/lib/engine/lifecycle";
import { CYCLE, cycleProgress, STATE_LABEL, type ActionState } from "@/lib/engine/stateMachine";
import { CHANNEL_LABEL, type Candidate, type EconomicModel } from "@/lib/engine/types";
import { euro, signedEuro } from "@/lib/format";
import { executionBlock, providerOfTarget } from "@/lib/integrations/capabilities";
import { flagFor } from "@/lib/services/flags";
import { WriteProof } from "@/components/WriteProof";
import { ExperimentPanel } from "@/components/ExperimentPanel";
import { getExperimentOfAction } from "@/lib/services/experiments";
import { writesOfAction } from "@/lib/services/pricelabs-write";
import { listAlerts } from "@/lib/services/execution-alerts";
import { AlertCard } from "@/components/AlertCard";
import { emailConfigured } from "@/lib/email/resend";
import { FloorGauge, PromoStack, Waterfall } from "@/components/Waterfall";
import { sharedAxis } from "@/lib/engine/waterfall";
import { auditTrail } from "@/lib/audit/query";
import { Runbook } from "@/components/Runbook";
import { needsProof } from "@/lib/promotions/confirmation";
import { todayISO } from "@/lib/dates";
import { getRunbook } from "@/lib/services/runbook";
import { auditLabel } from "@/lib/audit/types";
import { can, denyMessage, executePermission, ROLE_LABEL, rolesWith } from "@/lib/rbac";

export default async function Dossier({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ option?: string }> }) {
  const user = await requireUser();
  const { code } = await params;
  const [o] = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, user.tenantId), eq(schema.opportunities.code, decodeURIComponent(code))));
  if (!o) notFound();
  const [[p], acts, runs, talk, ints, linked] = await Promise.all([
    db.select().from(schema.properties).where(eq(schema.properties.id, o.propertyId)),
    db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id)),
    db.select().from(schema.agentRuns).where(eq(schema.agentRuns.opportunityId, o.id)).orderBy(asc(schema.agentRuns.createdAt)),
    db.select().from(schema.chatMessages).where(and(eq(schema.chatMessages.opportunityId, o.id), eq(schema.chatMessages.tenantId, user.tenantId))).orderBy(asc(schema.chatMessages.createdAt)),
    db.select().from(schema.integrations).where(eq(schema.integrations.tenantId, user.tenantId)),
    o.groupKey
      ? db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, user.tenantId), eq(schema.opportunities.propertyId, o.propertyId), eq(schema.opportunities.groupKey, o.groupKey), ne(schema.opportunities.id, o.id), eq(schema.opportunities.status, "OPEN"))).orderBy(asc(schema.opportunities.stayFrom))
      : Promise.resolve([]),
  ]);
  const restUntil = o.status === "DECIDED" ? endOfCooldown(o.decidedAt ?? o.createdAt, o.playbook) : null;
  const names = user.settings.agentNames ?? null;
  const cands = o.candidates as Candidate[];
  // avis des stratèges (US-072) ; les dossiers ouverts avant cette version n'en ont pas : on affiche ceux par règles, calculés à la volée
  const opinions = (o.signals.agentOpinions as Partial<Record<StrategistId, AgentOpinion>> | undefined) ?? deterministicOpinions({ candidates: cands, signalText: o.signals.signalText, stayFrom: o.stayFrom, stayTo: o.stayTo });
  const action = acts.find((a) => !["CANCELLED"].includes(a.status)) ?? null;
  const history = action ? await db.select().from(schema.actionTransitions).where(and(eq(schema.actionTransitions.tenantId, user.tenantId), eq(schema.actionTransitions.actionId, action.id))).orderBy(asc(schema.actionTransitions.createdAt), asc(schema.actionTransitions.id)) : [];
  // US-083 : trace d'audit du dossier et de son action, réservée aux rôles qui lisent le journal (US-084)
  const trail = can(user.role, "audit.read")
    ? [...(await auditTrail(user.tenantId, "Opportunity", o.id)), ...(action ? await auditTrail(user.tenantId, "RevenueAction", action.id) : [])].sort((a, b) => +a.createdAt - +b.createdAt)
    : null;
  const open = o.status === "OPEN";
  const q = Number((await searchParams).option);
  const idx = open && Number.isInteger(q) && cands[q] ? q : o.selected;
  const c = cands[idx];
  const axis = sharedAxis([c.current, c.proposed].filter((x): x is NonNullable<typeof x> => !!x).map((x) => x.steps));
  const model = p.economics as EconomicModel;
  const ref = c.proposed ?? c.current ?? cands.find((x) => x.current)?.current ?? null;
  const done = cycleProgress((action?.status as ActionState) ?? null);
  const settled = !open && !action;
  const conf = confidenceScale(o.confidence), risk = riskScale(c.risk);
  const d = o.diagnosis, nar = o.narrative;
  const kinds = [["fait", "Faits relevés", "block-faits"], ["comparaison", "Comparaisons", "block-comparaisons"], ["interpretation", "Interprétations", "block-interpretations"]] as const;
  const mode: string | undefined = action?.simulation?.executionMode;
  // US-084 : le serveur refuse ce que le rôle ne permet pas ; l'écran ne propose que ce qui sera accepté
  const canDecide = can(user.role, "decision.decide"), canExec = can(user.role, executePermission(mode)), canVerify = can(user.role, "action.verify"), canRollback = can(user.role, "action.rollback");
  // US-102 : guide pas-à-pas, seulement quand une action approuvée s'applique à la main (avancement lu en base)
  const runbook = action && action.status === "APPROVED" && mode !== "API_PRICELABS" ? await getRunbook(user.tenantId, action.id) : null;
  const who = (perm: Parameters<typeof rolesWith>[0]) => rolesWith(perm).map((r) => ROLE_LABEL[r].toLowerCase()).join(", ");
  const exec = action?.execution, meas = action?.measurement;
  const writes = action ? await writesOfAction(user.tenantId, action.id) : [];
  // US-110 : la référence figée avant l'action et les fenêtres de mesure
  const experiment = action ? await getExperimentOfAction(user.tenantId, action.id) : null;
  const actionAlerts = action ? (await listAlerts(user.tenantId, { actionId: action.id, resolvedLimit: 5 })).active : [];
  // US-002 : même règle que le serveur (`execute()`), pour ne jamais offrir un bouton qui sera refusé
  const target = providerOfTarget(action?.target?.system);
  const blocked = action ? executionBlock(mode, { actionType: action.type, provider: target, isDemo: p.isDemo, killSwitch: !!ints.find((i) => i.provider === target)?.killSwitch, flagOff: (await flagFor(user.tenantId, "write.api", { propertyId: p.id, provider: target })).reason }) : null;

  return (
    <Page title={`Dossier ${o.code} · ${p.name}`} sub={`${o.playbook} · ouvert le ${fmtDateTime(o.createdAt)} · ${fmtPeriod(o.stayFrom, o.stayTo)}`}
      crumbs={[{ label: "Opportunités", href: "/" }, { label: `Dossier ${o.code}` }]} right={<OppStatus status={o.status} decision={o.decision} actionStatus={action?.status} />}>
      <div className="page-head">
        <h1>{o.title}</h1>
        <p>{nar?.summary}</p>
        <p style={{ marginTop: 10 }} className="row-wrap">
          <Byline agent="direction" names={names} what={nar?.mode === "LLM" ? "a rédigé cette synthèse à partir des faits du dossier" : "synthèse composée par règles, sans modèle de langage"} />
          {p.isDemo && <span className="demo-pill">démonstration</span>}
        </p>
      </div>

      <section className="section" aria-labelledby="frise-h" style={{ marginTop: 0 }}>
        <h2 id="frise-h">Avancement du cycle</h2>
        <p className="section-note">Huit étapes, d'observer à mesurer. Chaque transition est contrôlée : aucune étape ne peut être sautée.</p>
        <ol className="frieze" role="list">
          {CYCLE.map((name, i) => {
            const st = settled && i >= 4 ? "na" : i < done ? "fait" : i === done ? "encours" : "avenir";
            const lib = { fait: "fait", encours: "en cours", avenir: "à venir", na: "non applicable" }[st];
            return (
              <li key={name} className={`is-${st}`}>
                <span className="fr-step"><span className="fr-glyph"><Icon name={st === "fait" ? "check" : st === "encours" ? "dot" : st === "na" ? "cross" : "clock"} /></span><span className="fr-no">{i + 1}/8</span></span>
                <span className="fr-name">{name}</span><span className="fr-state">{lib}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {(linked.length > 0 || restUntil) && (
        <section className="section" aria-labelledby="lies-h" data-testid="dossiers-lies" style={{ marginTop: 0 }}>
          <h2 id="lies-h">{linked.length > 0 ? "Dossiers liés" : "Période de repos"}</h2>
          {linked.length > 0 && (
            <>
              <p className="section-note">Ces dossiers du même logement portent sur des nuits qui se touchent : à lire ensemble avant de décider.</p>
              <ul className="linked-list">
                {linked.map((l) => (
                  <li key={l.id}><Link href={`/dossier/${encodeURIComponent(l.code)}`}><strong>{l.code}</strong> · {l.title}</Link><span className="faint"> · {fmtPeriod(l.stayFrom, l.stayTo)}</span></li>
                ))}
              </ul>
            </>
          )}
          {restUntil && (
            <p className="section-note" data-testid="repos">Après cette décision, le même signal ne rouvre pas de dossier {cooldownLabel(restUntil)} ({cooldownDaysOf(o.playbook)} jours de repos pour ce playbook). Rouvrir le dossier à la main reste possible.</p>
          )}
        </section>
      )}

      <section className="section" aria-labelledby="raison-h">
        <h2 id="raison-h">Raisonnement et preuves</h2>
        <p className="section-note">À gauche, la chaîne du raisonnement. À droite, les pièces qui la soutiennent, avec leur source.</p>
        <div className="dcols">
          <div className="registry">
            <article data-testid="signal-card"><span className="reg-key"><Icon name="signal" />Signal observé</span><p>{o.signals.signalText}</p>
              {Array.isArray(o.signals.signal?.measures) && o.signals.signal.measures.length > 0 && (
                <div className="table-wrap signal-measures"><table className="econ"><caption className="sr-only">Mesures du signal face à leur seuil</caption>
                  <thead><tr><th scope="col">Mesure</th><th scope="col">Observé</th><th scope="col">Seuil</th></tr></thead>
                  <tbody>{(o.signals.signal.measures as SignalMeasure[]).map((m) => { const f = formatMeasure(m); return <tr key={m.key}><th scope="row">{f.label}</th><td className="mono">{f.observed}</td><td className="mono">{f.threshold ?? "—"}</td></tr>; })}</tbody></table></div>
              )}
              <div className="reg-foot"><span className="metric-source">Source : {o.signals.signalSource}{o.signals.signal?.playbook ? ` · ${o.signals.signal.playbook}, fenêtre ${o.signals.signal.horizon}` : ""}</span></div></article>
            {(() => {
              // les dossiers ouverts avant l'US-071 n'ont pas encore d'analyse enregistrée : on affiche celle par règles, calculée à la volée (elle ne dépend que des pièces)
              const ma = (o.signals.marketAnalysis as MarketAnalysis | undefined) ?? deterministicAnalysis({ diagnosis: o.diagnosis, signalText: o.signals.signalText, stayFrom: o.stayFrom, stayTo: o.stayTo });
              return (
                <article data-testid="analyse-marche"><span className="reg-key"><Icon name="signal" />Analyse du marché</span>
                  <Byline agent="marche" names={names} what={ma.mode === "LLM" ? "a rédigé ces constats à partir des pièces numérotées" : "constats composés par règles à partir des pièces"} />
                  <ul className="findings" role="list">
                    {ma.findings.map((f, i) => (
                      <li key={i} data-testid="constat"><span>{f.statement}</span>{" "}
                        <span className="metric-source">Confiance {f.confidence.toLowerCase()} · preuves {f.evidence.map((id, k) => <span key={id}>{k > 0 ? ", " : ""}<a className="preuve-link" href={`#preuve-${id}`} data-testid="renvoi-preuve" aria-label={`Voir la pièce ${id} : ${ma.evidence.find((e) => e.id === id)?.label ?? ""}`}>{id}</a></span>)}</span></li>
                    ))}
                  </ul>
                  {ma.unknowns.length > 0 && <p className="muted findings-note" data-testid="analyse-inconnus">Inconnu : {ma.unknowns.join(" ")}</p>}
                  {ma.hypotheses.length > 0 && <p className="muted findings-note">Hypothèses concurrentes : {ma.hypotheses.map((h) => h.label).join(" ; ")}.</p>}
                </article>
              );
            })()}
            {o.signals.score && (
              <article data-testid="rang-card"><span className="reg-key"><Icon name="signal" />Pourquoi cette priorité</span>
                <p>Priorité {o.signals.score.score}, utilisée pour classer l'Inbox. Elle organise le travail et n'autorise ni n'écarte aucune action.</p>
                <div className="table-wrap score-table"><table className="econ"><caption className="sr-only">Composition du score de priorité</caption>
                  <thead><tr><th scope="col">Terme</th><th scope="col">Valeur</th></tr></thead>
                  <tbody>
                    <tr><th scope="row">Gain net attendu</th><td className="mono">{euro(Math.round(o.signals.score.impact * 100))}</td></tr>
                    <tr><th scope="row">× Confiance</th><td className="mono">{Math.round(o.signals.score.confidence * 100)} %</td></tr>
                    <tr><th scope="row">× Urgence</th><td className="mono">{String(o.signals.score.urgency).replace(".", ",")}</td></tr>
                    <tr><th scope="row">× Poids du playbook</th><td className="mono">{String(o.signals.score.weight).replace(".", ",")}</td></tr>
                    <tr><th scope="row">− Coût d'exécution</th><td className="mono">{euro(Math.round(o.signals.score.executionCost * 100))}</td></tr>
                    <tr><th scope="row">− Pénalité de risque</th><td className="mono">{o.signals.score.riskPenalty} pts</td></tr>
                    {o.signals.score.veto && <tr><th scope="row">+ Dossier sous veto, remonté pour être traité</th><td className="mono">oui</td></tr>}
                  </tbody></table></div>
              </article>
            )}
            <article><span className="reg-key"><Icon name="calendar" />Période</span><p className="mono">{fmtPeriod(o.stayFrom, o.stayTo)}</p></article>
            <article>
              <span className="reg-key"><Icon name="bulb" />Diagnostic</span>
              <p><strong>{d.primaryLabel}.</strong> {o.signals.hypothesisText}</p>
              <div className="reg-foot"><span className={`gauge-read gauge-conf`}><strong><Term id="confiance">Confiance</Term> {conf.label.toLowerCase()}</strong><span className="gauge-num">{conf.level}/4</span></span><span className="metric-source">{d.confidenceNote}</span></div>
            </article>
            <article>
              <span className="reg-key"><Icon name="search" />Arbre de diagnostic</span>
              <ul className="rules" style={{ marginTop: 8 }}>
                {d.tree.map((t: any, i: number) => (
                  <li key={i}><State role={t.verdict === "inconnu" ? "tech" : "neutre"}>{t.verdict}</State><span><strong>{t.question}</strong><br /><span className="rule-detail">{t.answer}</span></span></li>
                ))}
              </ul>
            </article>
            {d.alternatives.length > 0 && (
              <article>
                <span className="reg-key"><Icon name="bulb" />Hypothèses alternatives</span>
                <ul className="rules" style={{ marginTop: 8 }}>
                  {d.alternatives.map((a: any, i: number) => <li key={i}><Icon name="caret" /><span><strong>{a.label}</strong><br /><span className="rule-detail">{a.why}</span></span></li>)}
                </ul>
              </article>
            )}
          </div>
          <aside className="evidence" aria-labelledby="ev-h">
            <header><h3 id="ev-h">Volet de preuves</h3><p>Pièces relevées lors de la revue du {fmtDateTime(o.createdAt)}.</p></header>
            <div className="evidence-body">
              {kinds.map(([k, title, cls]) => {
                const ev = d.evidence.filter((e: any) => e.kind === k);
                if (!ev.length) return null;
                return (
                  <div className={`block ${cls}`} key={k} style={{ marginBottom: 10 }}>
                    <h3>{title}</h3>
                    <dl>{ev.map((e: any, i: number) => <div key={i} id={`preuve-E${d.evidence.indexOf(e) + 1}`} className={String(e.value).length > 24 ? "is-long" : undefined}><dt><span className="metric-source" data-testid="numero-preuve">E{d.evidence.indexOf(e) + 1}</span> {e.label}<br /><span className="metric-source">{e.source}</span></dt><dd>{e.value}</dd></div>)}</dl>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      </section>

      <section className="section" aria-labelledby="options-h">
        <h2 id="options-h">Options instruites</h2>
        <p className="section-note">Chaque option a été simulée en revenu net puis auditée. L'inaction est présentée au même niveau que les autres, pas comme un repoussoir.</p>
        <div className="options">
          {cands.map((x, i) => (
            <article key={i} className={`option${i === idx ? " is-selected" : ""}${x.audit.verdict === "REJECT" ? " is-rejected" : ""}`}>
              <div className="option-head">
                <div className="od-fill">
                  <h4>{x.label}{i === o.selected && <span className="tag" style={{ marginLeft: 8 }}>recommandée</span>}</h4>
                  <p>{x.detail}</p>
                </div>
                <VerdictState verdict={x.audit.verdict} />
              </div>
              <div className="option-meta">
                <div className="amount">
                  {x.type === "NO_ACTION" ? <><span className="gauge-label">Écart de contribution</span><span className="amount-value">référence</span></>
                    : x.expectedDeltaCents === null ? <><span className="gauge-label">Écart de contribution</span><Vq kind="nonchiffrable">Non chiffrable</Vq></>
                    : <><span className="sim-flag">Écart de contribution (simulation)</span><span className="amount-value">{signedEuro(x.expectedDeltaCents)}</span></>}
                </div>
                <Byline agent={x.agent} names={names} />
                <span className="spacer" />
                {open && i !== idx && <Link className="btn btn-ghost btn-sm" href={`/dossier/${o.code}?option=${i}#options-h`} scroll={false}><Icon name="search" />Examiner cette option</Link>}
                {i === idx && <span className="metric-source">option examinée ci-dessous</span>}
              </div>
              {(["pricing", "distribution"] as const).map((a) => {
                const op = opinions[a], it0 = op?.items.find((y) => y.candidate === i);
                // la seconde lecture peut abaisser le verdict après l'avis : l'avis affiché ne dépasse jamais le verdict en vigueur
                const it = it0 && (x.audit.verdict === "REJECT" ? { ...it0, stance: "DEFAVORABLE" as const } : x.audit.verdict === "NEEDS_HUMAN" && it0.stance === "FAVORABLE" ? { ...it0, stance: "RESERVES" as const } : it0);
                if (!op || !it) return null;
                return (
                  <div className="opinion" role="group" aria-label={`Avis de ${agentName(a, names)} sur cette option`} data-testid="avis-strateg" data-agent={a} key={a}>
                    <div className="opinion-head">
                      <Byline agent={a} names={names} what={op.mode === "LLM" ? "a donné son avis sur cette option" : "avis composé par règles"} />
                      <State role={it.stance === "FAVORABLE" ? "sain" : it.stance === "RESERVES" ? "attention" : "veto"}>{STANCE_LABEL[it.stance]}</State>
                    </div>
                    <p>{it.rationale}</p>
                    {it.watchpoints.length > 0 && <ul className="opinion-watch" role="list">{it.watchpoints.map((w, k) => <li key={k}>{w}</li>)}</ul>}
                  </div>
                );
              })}
              {i === o.selected && x.type !== "NO_ACTION" && (() => {
                const sr = o.signals.independentReview as IndependentReview | undefined;
                if (!sr || sr.mode !== "LLM" || sr.reviewed !== x.label) return null;
                return (
                  <div className="opinion" role="group" aria-label={`Seconde lecture de ${agentName("audit", names)} sur l'option retenue`} data-testid="seconde-lecture">
                    <div className="opinion-head">
                      <Byline agent="audit" names={names} what="seconde lecture, sans connaître les avis des autres postes" />
                      <State role={sr.concern ? "attention" : "sain"}>{sr.concern ? "réserve" : "aucune réserve"}</State>
                    </div>
                    {sr.concern ? <p>{sr.reason} <span className="metric-source">Preuves : {sr.evidence.map((id, k) => <span key={id}>{k > 0 ? ", " : ""}<a className="preuve-link" href={`#preuve-${id}`} aria-label={`Voir la pièce ${id}`}>{id}</a></span>)}. La validation humaine est requise.</span></p>
                      : <p className="muted">Les faits du dossier soutiennent l'option retenue. Cette lecture ne porte que sur l'option retenue, ne remplace pas les règles et ne peut qu'ajouter une alerte.</p>}
                  </div>
                );
              })()}
              <details className="fold">
                <summary><Icon name="shield" />Audit de {agentName("audit", names)} — {x.audit.rules.length} règle{x.audit.rules.length > 1 ? "s" : ""} contrôlée{x.audit.rules.length > 1 ? "s" : ""}</summary>
                <div className="fold-body">
                  <ul className="rules">
                    {x.audit.rules.map((r, j) => (
                      <li key={j}><State role={r.outcome === "PASS" ? "sain" : r.outcome === "WARN" ? "attention" : "veto"}>{r.outcome === "PASS" ? "conforme" : r.outcome === "WARN" ? "à valider" : "rejet"}</State><span><strong>{r.label}</strong> <code>{r.code}</code><br /><span className="rule-detail">{r.detail}</span></span></li>
                    ))}
                    {x.audit.rules.length === 0 && <li><State role="neutre">sans objet</State><span className="rule-detail">Aucune écriture : aucun garde-fou à contrôler.</span></li>}
                  </ul>
                  <p className="kpi-note">Hypothèse de simulation : {x.hypothesis}</p>
                </div>
              </details>
            </article>
          ))}
        </div>
      </section>

      {ref && (
        <section className="section" aria-labelledby="eco-h">
          <h2 id="eco-h">Économie</h2>
          <p className="section-note">Cascade identique sur les deux colonnes, du prix publié à la contribution. Calcul déterministe : aucun modèle de langage n'intervient ici.</p>
          <div className="cascade-wrap">
            <header>
              <h3>Simulation sur {ref.nights} nuit{ref.nights > 1 ? "s" : ""} · {CHANNEL_LABEL[ref.channel]}</h3>
              <p>{c.type === "NO_ACTION" ? "Situation actuelle, maintenue en cas d'inaction." : `Option examinée : ${c.label}.`} Séjour type de {ref.nights} nuit{ref.nights > 1 ? "s" : ""} au prix moyen des dates concernées.</p>
            </header>
            <Cascade current={c.current} proposed={c.proposed} />
            <div className="wf-grid" data-testid="waterfalls">
              {c.current && <Waterfall title="Cascade actuelle" result={c.current} axis={axis} />}
              {c.proposed && <Waterfall title="Cascade de l'option" result={c.proposed} axis={axis} />}
            </div>
            <FloorGauge hardCents={hardFloorCents(model, ref.channel, ref.nights)} strategyCents={strategyFloorCents(model, ref.channel, ref.nights)} soldBefore={c.current?.soldNightlyCents ?? null} soldAfter={c.proposed?.soldNightlyCents ?? null} />
            {(c.proposed || c.current) && <PromoStack result={c.proposed ?? c.current} capPct={typeof p.strategy?.maxDiscountStackPct === "number" ? p.strategy.maxDiscountStackPct : null} />}
            <div className="bounds">
              <div className="bound bound-cible"><span className="bound-k">Contribution visée par nuit</span><span className="bound-v"><Money cents={model.targetContributionPerNightCents} /></span></div>
              <div className="bound bound-plancher"><span className="bound-k"><Term id="plancher-strategique">Plancher stratégique</Term> · <Term id="prix-vendu">prix vendu</Term></span><span className="bound-v">{euro(strategyFloorCents(model, ref.channel, ref.nights))}</span></div>
              <div className="bound bound-plancher"><span className="bound-k"><Term id="plancher-absolu">Plancher absolu</Term> · <Term id="prix-vendu">prix vendu</Term></span><span className="bound-v">{euro(hardFloorCents(model, ref.channel, ref.nights))}</span></div>
              <div className="bound"><span className="bound-k">Origine des bornes</span><span className="bound-v" style={{ fontFamily: "var(--font)", fontSize: 13, color: "var(--quiet)" }}>{model.origin === "DEMO" ? "Valeurs de démonstration" : (model.provisional?.length ?? 0) > 0 ? `Planchers provisoires — à confirmer : ${model.provisional!.join(", ")}` : "Modèle économique déclaré"} · économie v{p.economicsVersion}</span></div>
            </div>
            {o.veto && o.signals.vetoText && (
              <div className="veto-strip"><Icon name="ban" /><div><h4><Term id="veto">Veto</Term> économique sur la situation actuelle</h4><p>{o.signals.vetoText}</p></div></div>
            )}
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="dec-h" id="decision">
        <h2 id="dec-h">Décision</h2>
        {open ? (
          <div className="decision">
            <h3>{c.type === "NO_ACTION" ? "Ne rien faire et réévaluer" : c.label}</h3>
            <p>{idx === o.selected ? nar?.recommendation : c.detail} {c.type !== "NO_ACTION" && "L'approbation prépare l'action : rien n'est écrit à l'instant de l'approbation."}</p>
            {(o.signals.independentReview as IndependentReview | undefined)?.concern && idx === o.selected && c.audit.rules.some((r) => r.code === "INDEPENDENT_REVIEW") && <p className="muted" data-testid="reserve-seconde-lecture" style={{ margin: "0 0 12px" }}>Réserve de la seconde lecture : {(o.signals.independentReview as IndependentReview).reason}</p>}
            {nar?.caveats?.length > 0 && idx === o.selected && <ul className="muted" style={{ margin: "0 0 16px", paddingLeft: 18 }}>{nar.caveats.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}
            {!canDecide ? (
              <div data-testid="lecture-seule"><Banner role="tech" title="Lecture seule : décision réservée">{denyMessage(user.role, "decision.decide")} Cette décision revient à : {who("decision.decide")}.</Banner></div>
            ) : c.audit.verdict === "REJECT" ? (
              <Banner role="veto" title="Option rejetée par l'auditeur">Elle ne peut pas être approuvée. {c.audit.rules.find((r) => r.outcome === "FAIL")?.detail}</Banner>
            ) : (
              <ActionForm action={approveAction} hidden={{ opportunityId: o.id, candidate: idx }}>
                {needsComment(c) && (
                  <div className="field" style={{ marginBottom: 14 }}>
                    <label htmlFor="comment">Commentaire d'approbation <span className="req" aria-hidden="true">*</span></label>
                    <textarea id="comment" name="comment" className="note" required minLength={8} aria-describedby="comment-help" />
                    <span className="help" id="comment-help">Obligatoire : {c.risk === "HIGH" ? "action à risque élevé" : "l'auditeur demande une validation humaine"}. Indiquez ce qui fonde votre accord ; il est consigné au journal.</span>
                  </div>
                )}
                <div className="decision-primary">
                  <Submit icon={c.type === "NO_ACTION" ? "pause" : "check"}>{c.type === "NO_ACTION" ? "Retenir l'inaction" : "Approuver"}</Submit>
                  <div className="amount od-fixed">
                    {c.type === "NO_ACTION" ? <><span className="gauge-label">Prochaine réévaluation</span><span className="amount-value">{c.reviewAt ? fmtDate(c.reviewAt) : "prochaine revue"}</span></>
                      : c.expectedDeltaCents === null ? <><span className="gauge-label">Écart de contribution</span><Vq kind="nonchiffrable">Non chiffrable</Vq></>
                      : <><span className="sim-flag">Écart de contribution (simulation)</span><span className="amount-value">{signedEuro(c.expectedDeltaCents)}</span></>}
                    <span className="amount-source">Risque {risk.label.toLowerCase()} · retour arrière : {c.rollbackPlan || "sans objet"}</span>
                  </div>
                </div>
              </ActionForm>
            )}
            {canDecide && <div className="decision-secondary">
              <ActionForm action={rejectAction} hidden={{ opportunityId: o.id, comment: "" }} className="inline"><Submit className="btn btn-danger" icon="cross">Rejeter la proposition</Submit></ActionForm>
              {!o.veto && <ActionForm action={deferAction} hidden={{ opportunityId: o.id }} className="inline"><Submit className="btn btn-ghost" icon="clock">Différer de 3 jours</Submit></ActionForm>}
            </div>}
            <p className="decision-note">{canDecide ? <>Une seule commande primaire. {o.veto ? "Un dossier sous veto ne peut pas être différé." : "Rejeter et différer sont consignés au journal."}</> : "Vous pouvez lire le dossier et poser une question à l'équipe."}</p>
          </div>
        ) : (
          <>
            <Banner role={o.decision === "REJECTED" || o.status === "EXPIRED" ? "tech" : "sain"} icon={o.status === "DEFERRED" ? "clock" : undefined}
              title={o.status === "DEFERRED" ? `Dossier différé jusqu'au ${o.deferUntil ? fmtDate(o.deferUntil) : "—"}` : o.status === "EXPIRED" ? "Dossier expiré : le signal a disparu ou la période est passée" : o.decision === "REJECTED" ? "Proposition rejetée" : o.decision === "NO_ACTION" ? "Inaction retenue" : `Option approuvée : ${action?.label ?? c.label}`}>
              {o.decision === "NO_ACTION" && <>Aucune écriture. {o.deferUntil && `Réévaluation prévue le ${fmtDate(o.deferUntil)}.`}</>}
              {action?.approvalComment && <>Commentaire : « {action.approvalComment} »</>}
              {o.decision === "APPROVED_SHADOW" && <> Logement en période d'observation : jugement hypothétique, aucune écriture externe.</>}
            </Banner>
            {!action && o.status !== "EXPIRED" && canDecide && (
              <ActionForm action={reopenAction} hidden={{ opportunityId: o.id }} style={{ marginTop: 12 }}><Submit className="btn btn-ghost btn-sm" icon="undo">Rouvrir le dossier</Submit></ActionForm>
            )}
          </>
        )}
      </section>

      {action && (
        <section className="section" aria-labelledby="suivi-h">
          <h2 id="suivi-h">Suivi d'application</h2>
          <p className="section-note">État de l'action : <strong>{STATE_LABEL[action.status as ActionState]}</strong>. Quatre strates, dans ce même dossier.</p>
          <div className="strata">
            <article className="stratum">
              <header><span className="st-no">1</span><h3>Instruction</h3><span className="badge badge-approb" style={{ marginLeft: "auto" }}><Icon name="check" />Approbation</span></header>
              <div className="stratum-body stack">
                <Recap rows={[
                  ["Outil cible", action.target.system === "PRICELABS" ? "PriceLabs" : action.target.system === "INTERNAL" ? "Tâche interne" : `Extranet ${CHANNEL_LABEL[action.target.system]}`],
                  ["Action", action.label],
                  ["Portée", (action.parameters.dates?.length ? `${action.parameters.dates.length} nuit${action.parameters.dates.length > 1 ? "s" : ""} · ` : "") + fmtPeriod(o.stayFrom, o.stayTo), true],
                  ["Mode d'exécution", mode === "API_PRICELABS" ? (p.isDemo ? "Écriture simulée (démonstration)" : "API PriceLabs") : mode === "MANUAL_RUNBOOK" ? "Procédure manuelle guidée" : "Tâche interne"],
                  ["Retour arrière", action.rollbackPlan],
                ]} />
                {action.status === "APPROVED" && !canExec && <div data-testid="execution-reservee"><Banner role="tech" title="Exécution réservée">{denyMessage(user.role, executePermission(mode))} Elle revient à : {who(executePermission(mode))}.</Banner></div>}
                {action.status === "APPROVED" && !canExec && runbook && <Runbook actionId={action.id} state={runbook} canCheck={false} />}
                {action.status === "APPROVED" && canExec && blocked && (
                  <>
                    <div id="exec-blocked"><Banner role="veto" title="Exécution impossible">{blocked}</Banner></div>
                    {runbook && <Runbook actionId={action.id} state={runbook} canCheck={false} />}
                    <div><button type="button" className="btn btn-primary" disabled aria-describedby="exec-blocked"><Icon name="ban" />{mode === "API_PRICELABS" ? "Recontrôler puis écrire" : "Déclarer la réalisation"}</button></div>
                  </>
                )}
                {action.status === "APPROVED" && canExec && !blocked && mode === "API_PRICELABS" && (
                  <>
                    <Banner role="attention" title="Recontrôle avant écriture">La grille est relue au moment de l'envoi : si une nuit a été réservée depuis la simulation, l'écriture est abandonnée.</Banner>
                    <ActionForm action={executeAction} hidden={{ actionId: action.id }}><Submit icon="search" pendingLabel="Recontrôle…">Recontrôler puis écrire</Submit></ActionForm>
                  </>
                )}
                {action.status === "APPROVED" && canExec && !blocked && mode !== "API_PRICELABS" && (
                  <>
                    <div>
                      <p className="gauge-label" style={{ marginBottom: 8 }}>Procédure pas à pas — {agentName(mode === "INTERNAL" ? "annonce" : "distribution", names)}</p>
                      <Runbook actionId={action.id} state={runbook!} canCheck={canExec} />
                    </div>
                    <ActionForm action={executeAction} hidden={{ actionId: action.id }}>
                      <div className="form-grid">
                        <div className="field"><label htmlFor="scope">{mode === "INTERNAL" ? "Constats et corrections retenues" : "Portée réellement appliquée"} <span className="req" aria-hidden="true">*</span></label>
                          <input id="scope" name="scope" type="text" required minLength={5} placeholder="aucune valeur préremplie" aria-describedby="scope-help" />
                          <span className="help" id="scope-help">Indiquez ce qui a été fait, pas ce qui était prévu.</span></div>
                        <div className="field"><label htmlFor="date">{mode === "MANUAL_RUNBOOK" ? "Date d'entrée en vigueur" : "Date d'application"} <span className="req" aria-hidden="true">*</span></label><input id="date" name="date" type="date" required max={todayISO()} aria-describedby="date-help" /><span className="help" id="date-help">Le jour où c'est fait, pas une date prévue.</span></div>
                        {mode === "MANUAL_RUNBOOK" && <div className="field"><label htmlFor="externalRef">Identifiant dans l'extranet{needsProof(action.type) ? " (ou preuve)" : ""}</label><input id="externalRef" name="externalRef" type="text" maxLength={120} autoComplete="off" aria-describedby="ref-help" /><span className="help" id="ref-help">{needsProof(action.type) ? "L'identifiant relevé, ou à défaut une preuve ci-dessous : l'un des deux est obligatoire." : "Facultatif ici."}</span></div>}
                        <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="proof">Preuve</label><input id="proof" name="proof" type="text" maxLength={1000} autoComplete="off" aria-describedby="proof-help" /><span className="help" id="proof-help">Numéro de confirmation ou lien vers une capture. Conservé comme texte : il n'est jamais ouvert ni suivi par NuitSignal.</span></div>
                      </div>
                      {mode === "MANUAL_RUNBOOK" && runbook && !runbook.progress.complete && <p className="section-note" data-testid="guide-incomplet" style={{ margin: "12px 0 0" }}>Guide pas-à-pas : {runbook.progress.done} étape{runbook.progress.done > 1 ? "s" : ""} cochée{runbook.progress.done > 1 ? "s" : ""} sur {runbook.progress.total}. Vous pouvez déclarer sans les avoir toutes cochées ; l'avancement sera conservé avec la confirmation.</p>}
                      <div style={{ marginTop: 16 }}><Submit icon="check">Déclarer la réalisation</Submit></div>
                    </ActionForm>
                    {mode === "MANUAL_RUNBOOK" && (
                      <details className="fold" data-testid="ecart"><summary>L'extranet ne correspond pas à l'action approuvée ?</summary>
                        <div className="fold-body">
                          <p className="help" style={{ margin: "0 0 10px" }}>Arrêtez-vous : n'improvisez pas une autre remise. L'action reste approuvée, rien n'est inscrit au registre, et un incident est ouvert pour les personnes qui décident.</p>
                          <ActionForm action={executeAction} hidden={{ actionId: action.id, mismatch: 1 }}>
                            <div className="field"><label htmlFor="ecart-note">Écart constaté <span className="req" aria-hidden="true">*</span></label><textarea id="ecart-note" name="scope" required minLength={10} maxLength={1000} rows={3} placeholder="Ce que dit l'extranet, ce qui était approuvé" /></div>
                            <div style={{ marginTop: 12 }}><Submit icon="alert" className="btn btn-ghost">Signaler un écart et arrêter</Submit></div>
                          </ActionForm>
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            </article>

            <article className="stratum">
              <header><span className="st-no">2</span><h3>Exécution</h3><span className="badge badge-applic" style={{ marginLeft: "auto" }}><Icon name="spin" />Application</span></header>
              <div className="stratum-body stack">
                {!exec ? <p className="muted" style={{ margin: 0 }}>Aucune exécution enregistrée.</p> : exec.error ? <Banner role="attention" title="Exécution en échec">{exec.error}</Banner> : (
                  <Recap rows={[
                    ["Mode", exec.mode === "PRICELABS_API" ? "Écriture PriceLabs (API), confirmée par relecture" : exec.mode === "DEMO_SIMULATED" ? "Écriture PriceLabs simulée" : exec.mode === "MANUAL_DECLARED" ? "Procédure manuelle déclarée" : "Tâche interne"],
                    ["Exécutée le", action.executedAt ? fmtDateTime(action.executedAt) : "—", true],
                    ...(exec.declaredScope ? [["Portée déclarée", exec.declaredScope] as [string, string]] : []),
                    ...(exec.mode === "MANUAL_DECLARED" ? [
                      ["Identifiant dans l'extranet", exec.externalRef ?? <Vq>non saisi</Vq>] as [string, React.ReactNode],
                      ["Preuve", exec.proof ?? <Vq>aucune pièce jointe</Vq>] as [string, React.ReactNode],
                      ["Date d'entrée en vigueur", exec.declaredDate ? fmtDay(exec.declaredDate) : <Vq>inconnue</Vq>, true] as [string, React.ReactNode, boolean],
                      ...(exec.runbook ? [["Guide pas-à-pas", `${exec.runbook.done} étape${exec.runbook.done > 1 ? "s" : ""} cochée${exec.runbook.done > 1 ? "s" : ""} sur ${exec.runbook.total}`] as [string, React.ReactNode]] : []),
                      ...(needsProof(action.type) ? [["Registre des promotions", <Link key="reg" href={`/logements/${p.id}?tab=canaux`}>Voir dans le registre du logement</Link>] as [string, React.ReactNode]] : []),
                    ] : []),
                    ...(exec.note ? [["Note", exec.note] as [string, string]] : []),
                  ]} />
                )}
              </div>
            </article>

            <WriteProof writes={writes} />
            {actionAlerts.length > 0 && (
              <div className="alert-list" data-testid="dossier-alerts" aria-label="Alertes de cette action">
                {actionAlerts.map((al) => <AlertCard key={al.id} alert={al} code={null} canAct={canRollback} emailOn={emailConfigured()} />)}
              </div>
            )}

            <article className="stratum">
              <header><span className="st-no">3</span><h3>Vérification</h3><span className="badge badge-verif" style={{ marginLeft: "auto" }}><Icon name="search" />Vérification</span></header>
              <div className="stratum-body stack">
                {action.status === "EXECUTED" && !canVerify && <div data-testid="verification-reservee"><Banner role="tech" title="Vérification réservée">{denyMessage(user.role, "action.verify")}</Banner></div>}
                {action.status === "EXECUTED" && canVerify && (
                  <ActionForm action={verifyAction} hidden={{ actionId: action.id }}>
                    <p className="muted" style={{ margin: "0 0 12px" }}>{exec?.mode === "PRICELABS_API" ? `${agentName("audit", names)} relit l'état réel chez PriceLabs et le compare à l'écriture enregistrée.` : exec?.mode === "DEMO_SIMULATED" ? `${agentName("audit", names)} relit la grille et la compare à l'action approuvée.` : <>Relisez l'état réel dans l'extranet, puis confirmez qu'il correspond à l'action approuvée. {exec?.mode === "MANUAL_DECLARED" && <span data-testid="regle-relecture">{rereadRule(exec, action.executedAt, user.id)}</span>}</>}</p>
                    <Submit icon="search">{exec?.mode === "PRICELABS_API" ? "Relire chez PriceLabs" : exec?.mode === "DEMO_SIMULATED" ? "Vérifier l'état relu" : "Confirmer la relecture"}</Submit>
                  </ActionForm>
                )}
                {exec?.verification ? <Recap rows={[["Vérifiée le", action.verifiedAt ? fmtDateTime(action.verifiedAt) : "—", true], ["Constat", exec.verification.note], ["Mesure prévue le", action.measureDueAt ? fmtDate(action.measureDueAt) : "—", true]]} />
                  : action.status !== "EXECUTED" && <p className="muted" style={{ margin: 0 }}>En attente de l'exécution.</p>}
              </div>
            </article>

            <article className="stratum">
              <header><span className="st-no">4</span><h3>Résultat observé</h3><span className="badge badge-verif" style={{ marginLeft: "auto" }}><Icon name="search" />Mesure</span></header>
              <div className="stratum-body">
                {meas ? (
                  <div className="result3">
                    <div className="r-obs"><h4>Observation</h4><p>{meas.observed}</p></div>
                    <div className="r-int"><h4>Interprétation</h4><p>{meas.interpretation} <span className="talk-mark">Lecture de {agentName("reporting", names)} · confiance {meas.confidence}</span></p></div>
                    <div className="r-eff"><h4><Term id="effet-incremental">Effet incrémental</Term></h4><p><span className="r-val">{meas.incrementalCents === null || meas.incrementalCents === undefined ? <Vq>Inconnu</Vq> : signedEuro(meas.incrementalCents)}</span> Aucune période témoin comparable : aucun gain n'est attribué à l'action.</p></div>
                  </div>
                ) : <p className="muted" style={{ margin: 0 }}>{action.status === "MEASURING" ? `Fenêtre d'observation en cours ; mesure le ${action.measureDueAt ? fmtDate(action.measureDueAt) : "—"}.` : action.status === "ROLLED_BACK" ? "Action annulée : aucune mesure." : "La mesure commence après la vérification."}</p>}
                {experiment && <ExperimentPanel experiment={experiment} />}
              </div>
            </article>
          </div>
          {["EXECUTED", "VERIFIED", "MEASURING", "FAILED"].includes(action.status) && canRollback && (
            <details className="fold" style={{ marginTop: 14 }}>
              <summary><Icon name="undo" />Retour arrière</summary>
              <div className="fold-body">
                <p className="muted" style={{ marginTop: 0 }}>Plan : {action.rollbackPlan} {exec?.mode === "MANUAL_DECLARED" && "Pour une procédure manuelle, effectuez d'abord l'opération inverse dans l'extranet."}{(exec?.mode === "PRICELABS_API" || exec?.writeId) && "Sur un logement réel, le retour arrière remet chez PriceLabs les valeurs d'avant (relues ensuite). Il est refusé si quelqu'un a modifié ces valeurs depuis, ou si le coupe-circuit est actif : les valeurs d'avant sont alors données pour les remettre à la main."}</p>
                <ActionForm action={rollbackAction} hidden={{ actionId: action.id }}>
                  <div className="field" style={{ marginBottom: 12 }}><label htmlFor="reason">Motif</label><input id="reason" name="reason" type="text" /></div>
                  <Submit className="btn btn-danger" icon="undo">Annuler l'action</Submit>
                </ActionForm>
              </div>
            </details>
          )}
        </section>
      )}

      {action && history.length > 0 && (
        <section className="section" aria-labelledby="transitions-h" data-testid="transitions">
          <h2 id="transitions-h">Historique des transitions</h2>
          <p className="section-note">Chaque changement d'état de l'action est consigné par la base elle-même : un état ne peut pas être sauté ni rétabli.</p>
          <ol className="transition-list" aria-label="Du plus ancien au plus récent">
            {history.map((h) => (
              <li key={h.id}>
                <span className="tr-state">{STATE_LABEL[h.toStatus as ActionState] ?? h.toStatus}</span>
                <span className="tr-from muted">{h.fromStatus ? `depuis ${STATE_LABEL[h.fromStatus as ActionState] ?? h.fromStatus}` : "création"}</span>
                <time className="tr-at muted" dateTime={h.createdAt.toISOString()}>{fmtDateTime(h.createdAt)}</time>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="section" aria-labelledby="trace-h" data-testid="trace-audit">
        <h2 id="trace-h">Traçabilité</h2>
        {trail === null ? <p className="section-note">{denyMessage(user.role, "audit.read")}</p> : (
          <>
            <p className="section-note">Ce que le journal d'audit a inscrit pour ce dossier et son action, du plus ancien au plus récent. Le journal est en ajout seul. <Link href="/historique#journal">Journal complet</Link></p>
            {trail.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucun événement : le dossier n'a pas encore été décidé.</p> : (
              <ol className="trace-list" role="list">{trail.slice(-20).map((e) => <li key={e.id}><time dateTime={e.createdAt.toISOString()}>{fmtDateTime(e.createdAt)} · {auditLabel(e.type)}</time><span>{e.summary}</span></li>)}</ol>
            )}
            {trail.length > 20 && <p className="muted" style={{ margin: "8px 0 0" }}>Les 20 derniers événements sur {trail.length} : le reste est dans le journal complet.</p>}
          </>
        )}
      </section>

      <section className="section" aria-labelledby="talk-h">
        <div className="agent-talk">
          <header>
            <h3 id="talk-h"><Icon name="chat" />Conversation avec {agentName("direction", names)}</h3>
            <p>Section distincte des preuves : une réponse d'agent est une interprétation, jamais une pièce.</p>
          </header>
          <AgentChat agentId="direction" opportunityId={o.id} agentLabel={agentName("direction", names)} inputId="talk-input" markPrefix="Réponse interprétative · " placeholder="Poser une question sur ce dossier…" emptyText="Aucun échange sur ce dossier."
            shortcuts={["Pourquoi cette recommandation ?", "Et si je ne fais rien ?", "Quelles sont les preuves ?"]}
            initial={talk.map((m) => ({ id: m.id, role: m.role === "user" ? "user" as const : "agent" as const, content: m.content, mode: m.mode ?? null, createdAt: m.createdAt.toISOString() }))} />
        </div>
      </section>

      <section className="section" aria-labelledby="who-h">
        <h2 id="who-h">Qui a fait quoi</h2>
        <p className="section-note">Chaque poste intervient une fois, dans un ordre fixe. Aucun agent n'en appelle un autre.</p>
        <ol className="flow">
          {[
            ["onboarding", "Rapprochement du calendrier et contrôle de fraîcheur"],
            ["marche", `Signal relevé : ${o.signals.signalText}`],
            ["direction", `Diagnostic : ${d.primaryLabel}`],
            ...[...new Set(cands.map((x) => x.agent).filter((a) => a !== "direction"))].map((a) => [a, cands.filter((x) => x.agent === a).map((x) => x.label).join(" · ")]),
            ["audit", `${cands.length} option${cands.length > 1 ? "s" : ""} auditée${cands.length > 1 ? "s" : ""} : ${cands.filter((x) => x.audit.verdict === "REJECT").length} rejet, ${cands.filter((x) => x.audit.verdict === "NEEDS_HUMAN").length} à valider avec commentaire`],
            ...runs.filter((r) => r.operation === "measure").map((r) => ["reporting", r.summary]),
          ].map(([a, what], i) => (
            <li key={i}><span className="n">{i + 1}</span><span className="who"><Byline agent={a} names={names} what="" /></span><span>{what}</span></li>
          ))}
          <li><span className="n">→</span><span className="who is-you">Vous</span><span>{open ? "Décision attendue" : o.decision === "REJECTED" ? "Proposition rejetée" : o.decision === "NO_ACTION" ? "Inaction retenue" : o.status === "DEFERRED" ? "Dossier différé" : o.status === "EXPIRED" ? "Aucune décision avant expiration" : "Option approuvée"}</span></li>
        </ol>
      </section>
      <p className="foot">Montants en euros, hors taxes de séjour. Les valeurs marquées « simulation » reposent sur l'hypothèse citée à côté d'elles et ne constituent pas un revenu acquis.{p.isDemo && " Logement de démonstration : données synthétiques."}</p>
    </Page>
  );
}

/** Règle de la seconde relecture (US-104), dite avant le clic : une autre personne, ou la même au moins 24 h après la confirmation. */
function rereadRule(exec: any, executedAt: Date | null, userId: string): string {
  const r = canVerifyManual({ executedAt, declaredBy: exec?.declaredBy ?? null, actorId: userId, now: new Date() });
  if (r.ok) return r.by === "OTHER_PERSON" ? "Vous n'êtes pas la personne qui a confirmé : vous pouvez relire maintenant." : `Plus de ${REREAD_MIN_HOURS} h se sont écoulées depuis la confirmation : vous pouvez relire.`;
  return `Vous avez confirmé cette action : la relecture revient à une autre personne, ou à vous au moins ${REREAD_MIN_HOURS} h après${r.earliest ? ` (à partir du ${r.earliest.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })})` : ""}.`;
}

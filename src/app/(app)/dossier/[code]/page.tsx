import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { approveAction, chatAction, deferAction, executeAction, rejectAction, reopenAction, rollbackAction, verifyAction } from "@/app/actions/decisions";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { needsComment } from "@/components/SitCard";
import { Banner, Byline, Cascade, confidenceScale, Money, OppStatus, Recap, riskScale, State, VerdictState, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtDateTime, fmtDay, fmtPeriod } from "@/lib/dates";
import { hardFloorCents, strategyFloorCents } from "@/lib/engine/economics";
import { CYCLE, cycleProgress, STATE_LABEL, type ActionState } from "@/lib/engine/stateMachine";
import { CHANNEL_LABEL, type Candidate, type EconomicModel } from "@/lib/engine/types";
import { euro, signedEuro } from "@/lib/format";

const RUNBOOK: Record<string, (c: Candidate) => string[]> = {
  CHANNEL_PROMO: (c) => [
    "Ouvrir l'extranet officiel du canal depuis votre navigateur, connecté à votre compte.",
    "Vérifier le logement, les dates de séjour et le fuseau horaire.",
    "Contrôler les promotions déjà actives et les comparer au registre.",
    `Créer la promotion « ${c.parameters.label ?? c.label} » à ${c.parameters.discountPct} %, séjours du ${fmtDay(c.parameters.stayFrom)} au ${fmtDay(c.parameters.stayTo)}.`,
    `Comparer le prix final affiché à la simulation : ${euro(c.proposed?.soldNightlyCents)} la nuit.`,
    "Relever l'identifiant ou la confirmation, puis déclarer la réalisation ci-dessous.",
    "Si l'état réel diffère de ce qui est approuvé : s'arrêter. Ne pas improviser une remise différente.",
  ],
  PROMO_REMOVAL: (c) => [
    "Ouvrir l'extranet officiel du canal, rubrique promotions.",
    `Repérer la promotion « ${c.parameters.promotionLabel} » et vérifier ses dates.`,
    "La désactiver pour les dates du dossier uniquement ; laisser les autres promotions en l'état.",
    `Contrôler le prix final affiché : ${euro(c.proposed?.soldNightlyCents)} la nuit attendus.`,
    "Déclarer la réalisation ci-dessous, avec la date et la référence de confirmation.",
  ],
  INVESTIGATION: (c) => [
    "Ouvrir l'extranet officiel du canal, rubrique promotions.",
    `Relever chaque promotion active : type, taux, dates de séjour. Le registre en attend ${(c.parameters.promotions ?? []).length}.`,
    "Signaler tout écart avec le registre dans le champ de portée ci-dessous.",
    "Déclarer la vérification : le registre est alors horodaté à aujourd'hui.",
  ],
  DEFAULT: (c) => [
    "Ouvrir PriceLabs sur le logement concerné.",
    `Appliquer : ${c.label}.`,
    "Relire la grille publiée pour les dates du dossier.",
    "Déclarer la réalisation ci-dessous.",
  ],
};

export default async function Dossier({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ option?: string }> }) {
  const user = await requireUser();
  const { code } = await params;
  const [o] = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, user.tenantId), eq(schema.opportunities.code, decodeURIComponent(code))));
  if (!o) notFound();
  const [[p], acts, runs, talk] = await Promise.all([
    db.select().from(schema.properties).where(eq(schema.properties.id, o.propertyId)),
    db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id)),
    db.select().from(schema.agentRuns).where(eq(schema.agentRuns.opportunityId, o.id)).orderBy(asc(schema.agentRuns.createdAt)),
    db.select().from(schema.chatMessages).where(and(eq(schema.chatMessages.opportunityId, o.id), eq(schema.chatMessages.tenantId, user.tenantId))).orderBy(asc(schema.chatMessages.createdAt)),
  ]);
  const names = user.settings.agentNames ?? null;
  const cands = o.candidates as Candidate[];
  const action = acts.find((a) => !["CANCELLED"].includes(a.status)) ?? null;
  const open = o.status === "OPEN";
  const q = Number((await searchParams).option);
  const idx = open && Number.isInteger(q) && cands[q] ? q : o.selected;
  const c = cands[idx];
  const model = p.economics as EconomicModel;
  const ref = c.proposed ?? c.current ?? cands.find((x) => x.current)?.current ?? null;
  const done = cycleProgress((action?.status as ActionState) ?? null);
  const settled = !open && !action;
  const conf = confidenceScale(o.confidence), risk = riskScale(c.risk);
  const d = o.diagnosis, nar = o.narrative;
  const kinds = [["fait", "Faits relevés", "block-faits"], ["comparaison", "Comparaisons", "block-comparaisons"], ["interpretation", "Interprétations", "block-interpretations"]] as const;
  const mode: string | undefined = action?.simulation?.executionMode;
  const exec = action?.execution, meas = action?.measurement;

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
        <ol className="frieze">
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

      <section className="section" aria-labelledby="raison-h">
        <h2 id="raison-h">Raisonnement et preuves</h2>
        <p className="section-note">À gauche, la chaîne du raisonnement. À droite, les pièces qui la soutiennent, avec leur source.</p>
        <div className="dcols">
          <div className="registry">
            <article><span className="reg-key"><Icon name="signal" />Signal observé</span><p>{o.signals.signalText}</p><div className="reg-foot"><span className="metric-source">Source : {o.signals.signalSource}</span></div></article>
            <article><span className="reg-key"><Icon name="calendar" />Période</span><p className="mono">{fmtPeriod(o.stayFrom, o.stayTo)}</p></article>
            <article>
              <span className="reg-key"><Icon name="bulb" />Diagnostic</span>
              <p><strong>{d.primaryLabel}.</strong> {o.signals.hypothesisText}</p>
              <div className="reg-foot"><span className={`gauge-read gauge-conf`}><strong>Confiance {conf.label.toLowerCase()}</strong><span className="gauge-num">{conf.level}/4</span></span><span className="metric-source">{d.confidenceNote}</span></div>
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
                    <dl>{ev.map((e: any, i: number) => <div key={i}><dt>{e.label}<br /><span className="metric-source">{e.source}</span></dt><dd>{e.value}</dd></div>)}</dl>
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
            <div className="bounds">
              <div className="bound bound-cible"><span className="bound-k">Contribution visée par nuit</span><span className="bound-v"><Money cents={model.targetContributionPerNightCents} /></span></div>
              <div className="bound bound-plancher"><span className="bound-k">Plancher stratégique · prix vendu</span><span className="bound-v">{euro(strategyFloorCents(model, ref.channel, ref.nights))}</span></div>
              <div className="bound bound-plancher"><span className="bound-k">Plancher absolu · prix vendu</span><span className="bound-v">{euro(hardFloorCents(model, ref.channel, ref.nights))}</span></div>
              <div className="bound"><span className="bound-k">Origine des bornes</span><span className="bound-v" style={{ fontFamily: "var(--font)", fontSize: 13, color: "var(--quiet)" }}>{model.origin === "DEMO" ? "Valeurs de démonstration" : "Modèle économique déclaré"} · stratégie v{p.strategyVersion}</span></div>
            </div>
            {o.veto && o.signals.vetoText && (
              <div className="veto-strip"><Icon name="ban" /><div><h4>Veto économique sur la situation actuelle</h4><p>{o.signals.vetoText}</p></div></div>
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
            {nar?.caveats?.length > 0 && idx === o.selected && <ul className="muted" style={{ margin: "0 0 16px", paddingLeft: 18 }}>{nar.caveats.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}
            {c.audit.verdict === "REJECT" ? (
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
            <div className="decision-secondary">
              <ActionForm action={rejectAction} hidden={{ opportunityId: o.id, comment: "" }} className="inline"><Submit className="btn btn-danger" icon="cross">Rejeter la proposition</Submit></ActionForm>
              {!o.veto && <ActionForm action={deferAction} hidden={{ opportunityId: o.id }} className="inline"><Submit className="btn btn-ghost" icon="clock">Différer de 3 jours</Submit></ActionForm>}
            </div>
            <p className="decision-note">Une seule commande primaire. {o.veto ? "Un dossier sous veto ne peut pas être différé." : "Rejeter et différer sont consignés au journal."}</p>
          </div>
        ) : (
          <>
            <Banner role={o.decision === "REJECTED" || o.status === "EXPIRED" ? "tech" : "sain"} icon={o.status === "DEFERRED" ? "clock" : undefined}
              title={o.status === "DEFERRED" ? `Dossier différé jusqu'au ${o.deferUntil ? fmtDate(o.deferUntil) : "—"}` : o.status === "EXPIRED" ? "Dossier expiré : le signal a disparu ou la période est passée" : o.decision === "REJECTED" ? "Proposition rejetée" : o.decision === "NO_ACTION" ? "Inaction retenue" : `Option approuvée : ${action?.label ?? c.label}`}>
              {o.decision === "NO_ACTION" && <>Aucune écriture. {o.deferUntil && `Réévaluation prévue le ${fmtDate(o.deferUntil)}.`}</>}
              {action?.approvalComment && <>Commentaire : « {action.approvalComment} »</>}
              {o.decision === "APPROVED_SHADOW" && <> Logement en période d'observation : jugement hypothétique, aucune écriture externe.</>}
            </Banner>
            {!action && o.status !== "EXPIRED" && (
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
                {action.status === "APPROVED" && mode === "API_PRICELABS" && (
                  <>
                    <Banner role="attention" title="Recontrôle avant écriture">La grille est relue au moment de l'envoi : si une nuit a été réservée depuis la simulation, l'écriture est abandonnée.</Banner>
                    <ActionForm action={executeAction} hidden={{ actionId: action.id }}><Submit icon="search" pendingLabel="Recontrôle…">Recontrôler puis écrire</Submit></ActionForm>
                  </>
                )}
                {action.status === "APPROVED" && mode !== "API_PRICELABS" && (
                  <>
                    <div>
                      <p className="gauge-label" style={{ marginBottom: 8 }}>Procédure pas à pas — {agentName(mode === "INTERNAL" ? "annonce" : "distribution", names)}</p>
                      {mode === "INTERNAL"
                        ? <ol className="runbook"><li>Relire titre, description et photos de chaque annonce.</li><li>Comparer les équipements déclarés à ceux du logement.</li><li>Relire les avis des 90 derniers jours et noter tout frein récurrent.</li><li>Consigner les corrections retenues ci-dessous.</li></ol>
                        : <ol className="runbook">{(RUNBOOK[action.type] ?? RUNBOOK.DEFAULT)({ ...c, parameters: action.parameters, label: action.label, proposed: action.simulation.proposed } as Candidate).map((s, i) => <li key={i}>{s}</li>)}</ol>}
                    </div>
                    <ActionForm action={executeAction} hidden={{ actionId: action.id }}>
                      <div className="form-grid">
                        <div className="field"><label htmlFor="scope">{mode === "INTERNAL" ? "Constats et corrections retenues" : "Portée réellement appliquée"} <span className="req" aria-hidden="true">*</span></label>
                          <input id="scope" name="scope" type="text" required minLength={5} placeholder="aucune valeur préremplie" aria-describedby="scope-help" />
                          <span className="help" id="scope-help">Indiquez ce qui a été fait, pas ce qui était prévu.</span></div>
                        <div className="field"><label htmlFor="date">Date d'application <span className="req" aria-hidden="true">*</span></label><input id="date" name="date" type="date" required /></div>
                        <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="proof">Référence ou preuve</label><input id="proof" name="proof" type="text" aria-describedby="proof-help" /><span className="help" id="proof-help">Identifiant de promotion, numéro de confirmation ou lien vers une capture.</span></div>
                      </div>
                      <div style={{ marginTop: 16 }}><Submit icon="check">Déclarer la réalisation</Submit></div>
                    </ActionForm>
                  </>
                )}
              </div>
            </article>

            <article className="stratum">
              <header><span className="st-no">2</span><h3>Exécution</h3><span className="badge badge-applic" style={{ marginLeft: "auto" }}><Icon name="spin" />Application</span></header>
              <div className="stratum-body stack">
                {!exec ? <p className="muted" style={{ margin: 0 }}>Aucune exécution enregistrée.</p> : exec.error ? <Banner role="attention" title="Exécution en échec">{exec.error}</Banner> : (
                  <Recap rows={[
                    ["Mode", exec.mode === "DEMO_SIMULATED" ? "Écriture PriceLabs simulée" : exec.mode === "MANUAL_DECLARED" ? "Procédure manuelle déclarée" : "Tâche interne"],
                    ["Exécutée le", action.executedAt ? fmtDateTime(action.executedAt) : "—", true],
                    ...(exec.declaredScope ? [["Portée déclarée", exec.declaredScope] as [string, string]] : []),
                    ...(exec.mode === "MANUAL_DECLARED" ? [["Preuve", exec.proof ?? <Vq>aucune pièce jointe</Vq>] as [string, React.ReactNode]] : []),
                    ...(exec.note ? [["Note", exec.note] as [string, string]] : []),
                  ]} />
                )}
              </div>
            </article>

            <article className="stratum">
              <header><span className="st-no">3</span><h3>Vérification</h3><span className="badge badge-verif" style={{ marginLeft: "auto" }}><Icon name="search" />Vérification</span></header>
              <div className="stratum-body stack">
                {action.status === "EXECUTED" && (
                  <ActionForm action={verifyAction} hidden={{ actionId: action.id }}>
                    <p className="muted" style={{ margin: "0 0 12px" }}>{exec?.mode === "DEMO_SIMULATED" ? `${agentName("audit", names)} relit la grille et la compare à l'action approuvée.` : "Relisez l'état réel dans l'outil, puis confirmez qu'il correspond à l'action approuvée."}</p>
                    <Submit icon="search">{exec?.mode === "DEMO_SIMULATED" ? "Vérifier l'état relu" : "Confirmer la relecture"}</Submit>
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
                    <div className="r-eff"><h4>Effet incrémental</h4><p><span className="r-val">{meas.incrementalCents === null || meas.incrementalCents === undefined ? <Vq>Inconnu</Vq> : signedEuro(meas.incrementalCents)}</span> Aucune période témoin comparable : aucun gain n'est attribué à l'action.</p></div>
                  </div>
                ) : <p className="muted" style={{ margin: 0 }}>{action.status === "MEASURING" ? `Fenêtre d'observation en cours ; mesure le ${action.measureDueAt ? fmtDate(action.measureDueAt) : "—"}.` : action.status === "ROLLED_BACK" ? "Action annulée : aucune mesure." : "La mesure commence après la vérification."}</p>}
              </div>
            </article>
          </div>
          {["EXECUTED", "VERIFIED", "MEASURING", "FAILED"].includes(action.status) && (
            <details className="fold" style={{ marginTop: 14 }}>
              <summary><Icon name="undo" />Retour arrière</summary>
              <div className="fold-body">
                <p className="muted" style={{ marginTop: 0 }}>Plan : {action.rollbackPlan} {exec?.mode === "MANUAL_DECLARED" && "Pour une procédure manuelle, effectuez d'abord l'opération inverse dans l'extranet."}</p>
                <ActionForm action={rollbackAction} hidden={{ actionId: action.id }}>
                  <div className="field" style={{ marginBottom: 12 }}><label htmlFor="reason">Motif</label><input id="reason" name="reason" type="text" /></div>
                  <Submit className="btn btn-danger" icon="undo">Annuler l'action</Submit>
                </ActionForm>
              </div>
            </details>
          )}
        </section>
      )}

      <section className="section" aria-labelledby="talk-h">
        <div className="agent-talk">
          <header>
            <h3 id="talk-h"><Icon name="chat" />Conversation avec {agentName("direction", names)}</h3>
            <p>Section distincte des preuves : une réponse d'agent est une interprétation, jamais une pièce.</p>
          </header>
          <div className="talk-log" role="log" aria-live="polite">
            {talk.length === 0 && <p className="muted" style={{ margin: 0 }}>Aucun échange sur ce dossier.</p>}
            {talk.map((m) => (
              <div key={m.id} className={`talk-turn${m.role === "user" ? " is-me" : ""}`}>
                <span className="talk-who">{m.role === "user" ? "Vous" : agentName("direction", names)}</span>
                <div className="talk-bubble">{m.content}{m.role !== "user" && <span className="talk-mark">Réponse interprétative · {m.mode === "LLM" ? "modèle de langage" : "composée par règles"} · {fmtDateTime(m.createdAt)}</span>}</div>
              </div>
            ))}
          </div>
          <div className="talk-form">
            <div className="talk-shortcuts">
              {["Pourquoi cette recommandation ?", "Et si je ne fais rien ?", "Quelles sont les preuves ?"].map((qq) => (
                <ActionForm key={qq} action={chatAction} hidden={{ agentId: "direction", opportunityId: o.id, question: qq }} className="inline"><Submit className="btn btn-ghost btn-sm" pendingLabel="…">{qq}</Submit></ActionForm>
              ))}
            </div>
            <ActionForm action={chatAction} hidden={{ agentId: "direction", opportunityId: o.id }}>
              <div className="talk-row">
                <label className="visually-hidden" htmlFor="talk-input">Votre question</label>
                <textarea id="talk-input" name="question" rows={1} placeholder="Poser une question sur ce dossier…" required />
                <Submit icon="send" pendingLabel="Envoi…">Envoyer</Submit>
              </div>
            </ActionForm>
          </div>
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

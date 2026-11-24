import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { Waterfall } from "@/components/Waterfall";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { CHANNELS, CHANNEL_LABEL } from "@/lib/engine/types";
import { AUDIENCE_LABEL } from "@/lib/promotions/registry";
import { advanceText, INTENTS, INTENT_KEYS, windowText, type ChannelOutcome } from "@/lib/promotions/compiler";
import { compileForProperty } from "@/lib/services/promotion-compiler";
import { euro } from "@/lib/format";

export const metadata = { title: "Compilateur de promotions" };
type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const STATUS: Record<ChannelOutcome["status"], { role: "sain" | "attention" | "veto"; label: string }> = {
  COMPILED: { role: "sain", label: "Promotion proposée" }, NEEDS_HUMAN: { role: "attention", label: "Décision humaine requise" }, NO_SAFE_EQUIVALENT: { role: "veto", label: "Aucun équivalent sûr" },
};

/**
 * Compilateur de promotions (US-101, blueprint §10.1 et §10.2) : une intention commerciale devient, canal par canal, la promotion à poser
 * dans l'extranet, ou un refus expliqué. Lecture seule : rien n'est enregistré ni envoyé à Airbnb ou Booking.com.
 */
export default async function Compilateur({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const [p] = await db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p) notFound();
  const submitted = Object.keys(sp).length > 0 && one(sp.intent) !== "";
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]));
  const compiled = submitted ? await compileForProperty(user.tenantId, p.id, raw) : null;
  const intent = one(sp.intent) || "STIMULATE_NEAR_TERM_DEMAND";
  return (
    <Page title="Compilateur de promotions" sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Compilateur de promotions" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}?tab=canaux`}><Icon name="back" />Retour aux canaux et promotions</Link></p>
      <div className="page-head">
        <h1 id="cp-title">Compilateur de promotions</h1>
        <p>Dites ce que vous voulez obtenir ; NuitSignal cherche, canal par canal, la promotion qui y répond sans passer sous vos planchers. Rien n'est posé chez Airbnb ou Booking.com : vous appliquez vous-même, pas à pas.</p>
      </div>
      <form method="get" className="card promo-card stack" style={{ gap: 14 }} aria-labelledby="cp-title">
        <div className="promo-grid">
          <div className="field">
            <label htmlFor="cp-intent">Intention<span className="req">*</span></label>
            <select id="cp-intent" name="intent" defaultValue={intent} required>{INTENT_KEYS.map((k) => <option key={k} value={k}>{INTENTS[k].label}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="cp-from">Séjours à partir du<span className="req">*</span></label><input id="cp-from" name="stayFrom" type="date" required defaultValue={one(sp.stayFrom)} /></div>
          <div className="field"><label htmlFor="cp-to">Séjours jusqu'au (départ exclu)<span className="req">*</span></label><input id="cp-to" name="stayTo" type="date" required defaultValue={one(sp.stayTo)} /></div>
          <div className="field"><label htmlFor="cp-max">Remise maximale acceptée (%)<span className="req">*</span></label><input id="cp-max" name="maxDiscountPct" type="text" inputMode="decimal" required defaultValue={one(sp.maxDiscountPct) || "10"} autoComplete="off" /></div>
          <div className="field"><label htmlFor="cp-los">Séjour minimal (nuits)</label><input id="cp-los" name="minLos" type="text" inputMode="numeric" defaultValue={one(sp.minLos)} autoComplete="off" /><span className="help">Longs séjours : 7 par défaut.</span></div>
          <div className="field"><label htmlFor="cp-adv">Délai avant l'arrivée (jours)</label><input id="cp-adv" name="advanceDays" type="text" inputMode="numeric" defaultValue={one(sp.advanceDays)} autoComplete="off" /><span className="help">Demande proche : au plus, de 1 à 60 (7 par défaut). Très anticipé : au moins, de 30 à 365 (60 par défaut). Sans effet pour les autres intentions.</span></div>
        </div>
        <fieldset className="promo-grid" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>Canaux et prix publié par nuit (€)</legend>
          {CHANNELS.map((c) => (
            <div className="field" key={c}>
              <label className="pick" htmlFor={`cp-ch-${c}`} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, cursor: "pointer" }}><input id={`cp-ch-${c}`} type="checkbox" name={`channel_${c}`} defaultChecked={!submitted || one(sp[`channel_${c}`]) === "on"} style={{ width: 18, height: 18, accentColor: "var(--blue-core)" }} />{CHANNEL_LABEL[c]}</label>
              <label htmlFor={`cp-pr-${c}`} className="sr-only">Prix publié par nuit sur {CHANNEL_LABEL[c]}</label>
              <input id={`cp-pr-${c}`} name={`price_${c}`} type="text" inputMode="decimal" placeholder="120" defaultValue={one(sp[`price_${c}`])} autoComplete="off" />
            </div>
          ))}
        </fieldset>
        <p className="section-note" style={{ margin: 0 }}>Le prix publié est celui affiché sur le canal, majoration comprise. Sans séjour minimal, les planchers sont vérifiés pour un séjour d'une nuit (le plus exigeant), et pour toutes les saisons que la fenêtre traverse.</p>
        <div><button className="btn btn-primary" type="submit"><Icon name="check" />Compiler</button></div>
      </form>

      {compiled && !compiled.ok && <Banner role="attention" title="Saisie à corriger" style={{ marginTop: 16 }}>{compiled.error}</Banner>}
      {compiled?.ok && (
        <section className="stack" style={{ gap: 14, marginTop: 16 }} aria-label="Résultat par canal" data-testid="compile-result">
          <p className="section-note" style={{ margin: 0 }}>{INTENTS[compiled.input.intent].label} · {windowText({ stayFrom: compiled.input.stayFrom, stayTo: compiled.input.stayTo })} · remise maximale {compiled.input.maxDiscountPct} %.</p>
          {compiled.result.outcomes.map((o) => <Outcome key={o.channel} o={o} />)}
          <Banner role="tech" title="Côté PriceLabs">{compiled.result.pricelabsNote}</Banner>
        </section>
      )}
    </Page>
  );
}

function Outcome({ o }: { o: ChannelOutcome }) {
  const st = STATUS[o.status];
  return (
    <article className="card promo-card" data-testid={`compile-${o.channel}`} data-status={o.status} aria-label={`${CHANNEL_LABEL[o.channel]} : ${st.label}`}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{CHANNEL_LABEL[o.channel]}</h2>
        <State role={st.role}>{st.label}</State>
      </header>
      {o.status === "NO_SAFE_EQUIVALENT" ? <p style={{ margin: 0 }}>{o.reason}</p> : (
        <>
          <dl className="promo-facts">
            <div><dt>Type à choisir dans l'extranet</dt><dd>{o.settings.kindLabel}</dd></div>
            <div><dt>Remise</dt><dd>{o.settings.discountPct} %</dd></div>
            <div><dt>Séjours</dt><dd>{windowText(o.settings)}</dd></div>
            {o.settings.minLos !== null && <div><dt>Séjour minimal</dt><dd>{o.settings.minLos} nuits</dd></div>}
            {advanceText(o.settings) && <div><dt>Fenêtre de réservation</dt><dd>{advanceText(o.settings)}</dd></div>}
            <div><dt>Audience</dt><dd>{AUDIENCE_LABEL[o.settings.audience] ?? o.settings.audience}</dd></div>
            <div><dt>Prix vendu par nuit</dt><dd>{euro(o.simulation.result.soldNightlyCents, true)} (plancher stratégique {euro(o.simulation.floors.strategyCents, true)}, absolu {euro(o.simulation.floors.hardCents, true)})</dd></div>
          </dl>
          {o.humanReasons.map((r, i) => <Banner key={i} role="attention" title="À confirmer dans l'extranet">{r}</Banner>)}
          {o.notes.map((n, i) => <p key={i} className="section-note" style={{ margin: "8px 0 0" }}>{n}</p>)}
          <details style={{ marginTop: 12 }}><summary>Voir la cascade du revenu</summary><Waterfall title={`Cascade ${CHANNEL_LABEL[o.channel]}`} result={o.simulation.result} /></details>
        </>
      )}
    </article>
  );
}

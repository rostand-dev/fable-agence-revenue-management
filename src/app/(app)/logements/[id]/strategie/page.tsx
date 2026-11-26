import Link from "next/link";
import { notFound } from "next/navigation";
import { discardStrategyDraftAction, publishStrategyAction, rollbackStrategyAction, saveStrategyDraftAction } from "@/app/actions/strategy";
import { Icon } from "@/components/Icon";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { euro } from "@/lib/format";
import { STRATEGY_SOURCE_LABEL } from "@/lib/strategy";
import { PortfolioError } from "@/lib/services/portfolio";
import { getStrategyState } from "@/lib/services/strategy";
import { RightsNotice } from "@/components/Rights";

export const metadata = { title: "Strategy Builder" };
const when = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });
const SR = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

function ChangeList({ changes, label }: { changes: { key: string; label: string; from: string | null; to: string | null }[]; label: string }) {
  return (
    <ul role="list" aria-label={label} className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 10 }}>
      {changes.map((c) => (
        <li key={c.key} style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline", justifyContent: "space-between" }}>
          <strong>{c.label}</strong>
          <span><span className="muted">{c.from ?? "non renseigné"}</span><span aria-hidden="true"> → </span><span style={SR}> devient </span><strong>{c.to ?? "non renseigné"}</strong></span>
        </li>
      ))}
    </ul>
  );
}

/** Strategy Builder (US-023) : brouillon sans effet, comparaison avec la stratégie en vigueur, publication, historique et restauration. */
export default async function StrategyBuilder({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let s;
  try { s = await getStrategyState(user.tenantId, id); } catch (e) { if (e instanceof PortfolioError) notFound(); throw e; }
  const p = { id };
  const editable = !s.isDemo && s.status !== "ONBOARDING";
  const form = s.draft?.values ?? s.published;
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement>, help?: string) => (
    <div className="field"><label htmlFor={"sb-" + name}>{label}</label><input id={"sb-" + name} name={name} {...props} aria-describedby={help ? "sb-" + name + "-help" : undefined} />{help && <span className="help" id={"sb-" + name + "-help"}>{help}</span>}</div>
  );
  return (
    <Page title="Strategy Builder" sub={`${s.name} · stratégie v${s.version}`} crumbs={[{ label: "Logements", href: "/logements" }, { label: s.name, href: `/logements/${p.id}` }, { label: "Strategy Builder" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}?tab=strategie`}><Icon name="back" />Retour à la stratégie</Link></p>
      <div className="page-head">
        <h1>Strategy Builder</h1>
        <p>Préparez vos réglages en brouillon, comparez-les à la stratégie en vigueur, puis publiez. Rien ne change avant la publication, et chaque version reste consultable et restaurable.</p>
      </div>
      <RightsNotice need="property.manage" />
      <p data-testid="strategy-status"><State role="sain">version {s.version} en vigueur</State>{s.draft && <> <State role={s.draft.stale ? "attention" : "neutre"}>{s.draft.stale ? "brouillon périmé" : "brouillon en cours"}</State></>}</p>
      <Banner role="tech" title="Prix de base, minimum et maximum : pilotés par PriceLabs" style={{ marginBottom: 16 }}>
        Base {euro(s.current.basePriceCents ?? null)} · minimum {euro(s.current.minPriceCents ?? null)} · maximum {euro(s.current.maxPriceCents ?? null)}. Ils suivent PriceLabs et les actions que vous approuvez ; le Builder règle le reste.
      </Banner>
      {!editable ? <Banner role="tech" title="Réglages non modifiables ici">{s.isDemo ? "Un logement de démonstration ne se modifie pas." : "Ce logement est en cours de création : la stratégie se règle dans le parcours guidé."}</Banner> : (
        <section aria-labelledby="sb-draft">
          <h2 id="sb-draft">Brouillon</h2>
          <ActionForm need="property.manage" action={saveStrategyDraftAction} hidden={{ propertyId: p.id, baseVersion: s.version }}>
            <div className="form-grid">
              <div style={{ gridColumn: "1 / -1" }}>{field("objective", "Objectif", { type: "text", maxLength: 160, defaultValue: form.objective ?? "", placeholder: "ex. protéger le revenu net des séjours professionnels", autoComplete: "off" })}</div>
              <div style={{ gridColumn: "1 / -1" }}>{field("positioning", "Positionnement", { type: "text", maxLength: 120, defaultValue: form.positioning ?? "", autoComplete: "off" })}</div>
              {field("minStay", "Séjour minimum (nuits)", { type: "text", inputMode: "numeric", defaultValue: form.minStay ?? "", placeholder: "inconnu si vide", autoComplete: "off" }, "De 1 à 30.")}
              {field("maxDiscountStackPct", "Cumul de remises maximal (%)", { type: "text", inputMode: "decimal", required: true, defaultValue: String(form.maxDiscountStackPct).replace(".", ","), autoComplete: "off" }, "De 0 à 50. Au-delà, l'auditeur oppose son veto.")}
              {field("maxPriceChangePct", "Variation de prix sans validation renforcée (%)", { type: "text", inputMode: "decimal", required: true, defaultValue: String(form.maxPriceChangePct).replace(".", ","), autoComplete: "off" }, "De 1 à 30.")}
            </div>
            <div className="row-wrap" style={{ marginTop: 16 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer le brouillon</Submit></div>
          </ActionForm>
          {s.draft && (
            <div style={{ marginTop: 24 }} data-testid="strategy-draft-diff">
              <h2>Ce que la publication changerait</h2>
              {s.draft.stale && <Banner role="attention" title="La stratégie a changé depuis ce brouillon" style={{ marginBottom: 12 }}>Le brouillon reposait sur la version {s.draft.baseVersion}, la version {s.version} est en vigueur. Relisez les réglages ci-dessus puis enregistrez de nouveau le brouillon pour pouvoir publier.</Banner>}
              {s.draft.changes.length === 0 ? <p className="section-note">Le brouillon est identique à la stratégie en vigueur : rien à publier.</p> : <ChangeList changes={s.draft.changes} label="Changements du brouillon" />}
              <div className="row-wrap" style={{ marginTop: 16, alignItems: "flex-start" }}>
                {!s.draft.stale && s.draft.changes.length > 0 && (
                  <ActionForm need="property.manage" action={publishStrategyAction} hidden={{ propertyId: p.id }} style={{ flex: "1 1 280px" }}>
                    <div className="field"><label htmlFor="sb-note">Note de publication (facultative)</label><input id="sb-note" name="note" type="text" maxLength={300} autoComplete="off" /></div>
                    <div className="row-wrap" style={{ marginTop: 12 }}><Submit icon="check" pendingLabel="Publication…">Publier la stratégie</Submit></div>
                  </ActionForm>
                )}
                <ActionForm need="property.manage" action={discardStrategyDraftAction} hidden={{ propertyId: p.id }}>
                  <Submit className="btn btn-ghost" icon="cross" pendingLabel="Abandon…">Abandonner le brouillon</Submit>
                </ActionForm>
              </div>
            </div>
          )}
        </section>
      )}
      <section aria-labelledby="sb-history" style={{ marginTop: 28 }}>
        <h2 id="sb-history">Historique des versions</h2>
        <div className="stack" data-testid="strategy-versions">
          {s.versions.map((v) => (
            <details className="fold" key={v.id} data-testid="strategy-version" open={v.version === s.version}>
              <summary style={{ flexWrap: "wrap", rowGap: 6 }}>
                <span>Version {v.version}</span>
                <span className="muted">{when(v.createdAt)} · {v.author} · {STRATEGY_SOURCE_LABEL[v.source] ?? v.source}</span>
                <span style={{ marginLeft: "auto" }}>{v.version === s.version ? <State role="sain">en vigueur</State> : <State role="neutre">ancienne</State>}</span>
              </summary>
              <div className="fold-body">
                {v.note && <p style={{ margin: "0 0 12px" }}>« {v.note} »</p>}
                {v.changes.length === 0 ? <p style={{ margin: 0 }}>Version de départ : stratégie reprise telle quelle.</p> : <ChangeList changes={v.changes} label={`Changements de la version ${v.version}`} />}
                {editable && v.version !== s.version && (
                  <ActionForm need="property.manage" action={rollbackStrategyAction} hidden={{ propertyId: p.id, version: v.version }} style={{ marginTop: 16 }}>
                    <div className="field"><label htmlFor={"rb-" + v.version}>Note (facultative)</label><input id={"rb-" + v.version} name="note" type="text" maxLength={300} autoComplete="off" /></div>
                    <div className="row-wrap" style={{ marginTop: 12 }}><Submit className="btn btn-ghost btn-sm" icon="history" pendingLabel="Restauration…">Restaurer les réglages de cette version</Submit></div>
                    <p className="section-note" style={{ margin: "8px 0 0" }}>Crée une nouvelle version avec ces réglages. Les prix de base, minimum et maximum ne sont pas restaurés.</p>
                  </ActionForm>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>
    </Page>
  );
}

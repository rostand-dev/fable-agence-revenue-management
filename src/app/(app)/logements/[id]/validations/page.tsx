import Link from "next/link";
import { notFound } from "next/navigation";
import { recordReconciliationAction, validateFloorsAction } from "@/app/actions/validations";
import { Icon } from "@/components/Icon";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { RECONCILIATION_MAX_GAP_PCT, RECONCILIATION_MIN_SAMPLE } from "@/lib/activation-gates";
import { requireUser } from "@/lib/auth";
import { CHANNEL_LABEL, type Channel } from "@/lib/engine/types";
import { euro } from "@/lib/format";
import { PortfolioError } from "@/lib/services/portfolio";
import { getQuality } from "@/lib/services/quality";
import { getValidations } from "@/lib/services/validations";

export const metadata = { title: "Validations avant activation" };
const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" }) : "";

/** Validations humaines demandées avant l'activation (blueprint §6.1) : planchers, rapprochement d'un échantillon de réservations, durée d'observation. */
export default async function Validations({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let v, q;
  try { [v, q] = await Promise.all([getValidations(user.tenantId, id), getQuality(user.tenantId, id)]); } catch (e) { if (e instanceof PortfolioError) notFound(); throw e; }
  const editable = !v.isDemo && v.status === "SHADOW";
  const shadow = q.items.find((i) => i.key === "shadow")!;
  const minDays = q.minDays;
  const byChannel = new Map<string, typeof v.grid>();
  for (const g of v.grid) byChannel.set(g.channel, [...(byChannel.get(g.channel) ?? []), g]);
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement>, help?: string) => (
    <div className="field"><label htmlFor={"va-" + name}>{label}</label><input id={"va-" + name} name={name} {...props} aria-describedby={help ? "va-" + name + "-help" : undefined} />{help && <span className="help" id={"va-" + name + "-help"}>{help}</span>}</div>
  );
  const frState = (ok: boolean) => ok ? "sain" : "violation";
  return (
    <Page title="Validations avant activation" sub={v.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: v.name, href: `/logements/${id}` }, { label: "Checklist de qualité", href: `/logements/${id}/qualite` }, { label: "Validations" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${id}/qualite`}><Icon name="back" />Retour à la checklist</Link></p>
      <div className="page-head">
        <h1>Validations avant activation</h1>
        <p>Trois conditions précèdent le passage à « Actif » : {minDays === 0 ? "l'observation lancée (aucun délai minimum configuré)" : `une observation d'au moins ${minDays} jour${minDays > 1 ? "s" : ""}`}, des planchers validés par une personne et un échantillon de réservations rapproché.</p>
      </div>
      {!editable && <Banner role="tech" title="Validations en lecture seule" style={{ marginBottom: 16 }}>{v.isDemo ? "Un logement de démonstration ne se valide pas." : v.status === "ACTIVE" ? "Ce logement est déjà actif." : "Les validations se font une fois l'observation lancée."}</Banner>}

      <section aria-labelledby="va-shadow">
        <h2 id="va-shadow">Observation</h2>
        <p data-testid="validation-shadow"><State role={frState(shadow.ok)}>{shadow.ok ? "satisfaite" : "en cours"}</State> {shadow.detail}</p>
      </section>

      <section aria-labelledby="va-floors" style={{ marginTop: 28 }}>
        <h2 id="va-floors">Planchers</h2>
        <p data-testid="validation-floors"><State role={frState(v.floors.status === "OK")}>{v.floors.status === "OK" ? "validés" : v.floors.status === "STALE" ? "à valider de nouveau" : v.floors.status === "INCOMPLETE" ? "incomplets" : "non validés"}</State> {q.items.find((i) => i.key === "floors")!.detail}</p>
        {v.floors.status === "INCOMPLETE" ? <Banner role="attention" title="Modèle économique incomplet">Les planchers se calculent à partir des coûts et commissions. <Link href={`/logements/${id}/couts`}>Compléter les coûts</Link></Banner> : (
          <>
            <p className="section-note">Les planchers saisonniers sont validés avec la grille mais ne sont pas encore appliqués par l'auditeur (US-053). Plancher dur : en dessous, le revenu net ne couvre pas la contribution minimale. Plancher stratégie : la contribution visée. Montants par nuit.</p>
            <div className="stack" style={{ gap: 16 }}>
              {[...byChannel].map(([ch, cells]) => (
                <div key={ch} className="card" style={{ padding: 16 }} data-testid={`floor-${ch}`}>
                  <h3 style={{ margin: "0 0 8px" }}>{CHANNEL_LABEL[ch as Channel] ?? ch}</h3>
                  <ul role="list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                    {cells.map((c) => (
                      <li key={c.nights} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "2px 12px" }}>
                        <strong>{c.nights} nuits</strong>
                        <span>dur <strong>{euro(c.hardCents)}</strong> · stratégie <strong>{euro(c.strategyCents)}</strong></span>
                        {c.seasons.length > 0 && <span className="muted" style={{ flexBasis: "100%", textAlign: "right" }} data-testid="floor-seasons">{c.seasons.map((x) => `${x.label} : stratégie ${euro(x.strategyCents)}`).join(" · ")}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {editable && (
              <ActionForm action={validateFloorsAction} hidden={{ propertyId: id, fingerprint: v.fingerprint ?? "" }}>
                {field("note", "Commentaire (facultatif)", { type: "text", maxLength: 300, autoComplete: "off" })}
                <Submit icon="check" pendingLabel="Validation…">{v.floors.status === "OK" ? "Valider de nouveau les planchers" : "Valider ces planchers"}</Submit>
              </ActionForm>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="va-reco" style={{ marginTop: 28 }}>
        <h2 id="va-reco">Rapprochement de réservations</h2>
        <p data-testid="validation-reconciliation"><State role={frState(v.reconciliation.status === "OK")}>{v.reconciliation.status === "OK" ? "attesté" : v.reconciliation.status === "NONE" ? "non fait" : "insuffisant"}</State> {q.items.find((i) => i.key === "reconciliation")!.detail}</p>
        {v.reconciliationDetail && <p className="section-note">Source indiquée : {v.reconciliationDetail.source}{v.reconciliationDetail.note ? ` · ${v.reconciliationDetail.note}` : ""}. Fait le {when(v.reconciliation.at)}.</p>}
        <p className="section-note">Comparez au moins {RECONCILIATION_MIN_SAMPLE} réservations de l'outil de réservation avec les relevés des plateformes (montants, dates, frais). Indiquez le plus grand écart constaté : il ne doit pas dépasser {RECONCILIATION_MAX_GAP_PCT} %. Cette attestation sera remplacée par un calcul automatique quand l'ingestion SuperHote sera en place.</p>
        {editable && (
          <ActionForm action={recordReconciliationAction} hidden={{ propertyId: id }}>
            {field("sampleSize", "Réservations comparées", { type: "number", inputMode: "numeric", min: 1, max: 1000, step: 1, required: true }, `Au moins ${RECONCILIATION_MIN_SAMPLE}.`)}
            {field("maxGapPct", "Plus grand écart constaté (%)", { type: "text", inputMode: "decimal", required: true, placeholder: "0" }, `Au plus ${RECONCILIATION_MAX_GAP_PCT} % ; mettez 0 si tout concorde.`)}
            {field("source", "Source du rapprochement", { type: "text", maxLength: 120, required: true, autoComplete: "off" }, "Par exemple : SuperHote comparé aux relevés Airbnb et Booking.")}
            {field("note", "Commentaire (facultatif)", { type: "text", maxLength: 300, autoComplete: "off" })}
            <Submit icon="check" pendingLabel="Enregistrement…">Enregistrer le rapprochement</Submit>
          </ActionForm>
        )}
      </section>
    </Page>
  );
}

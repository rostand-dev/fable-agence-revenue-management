import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/Icon";
import { MappingConfirmForm } from "@/components/MappingConfirmForm";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { MAPPING_STATUS_LABEL, type MappingState } from "@/lib/mapping";
import { getMapping } from "@/lib/services/mapping";
import { fmtDate } from "@/lib/dates";

export const metadata = { title: "Mapping des identifiants" };
const ROLE: Record<MappingState, "sain" | "attention" | "neutre"> = { ok: "sain", warning: "attention", missing: "neutre" };
const STATE_LABEL: Record<MappingState, string> = { ok: "rattaché", warning: "à vérifier", missing: "non renseigné" };
const FIX_LABEL = { pricelabs: "Ouvrir PriceLabs", superhote: "Ouvrir SuperHote", annonces: "Ouvrir les annonces" } as const;

/** Mapping des identifiants externes (US-021) : ce que chaque outil désigne, les écarts à contrôler, et la confirmation par une personne. */
export default async function Mapping({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p) notFound();
  const m = await getMapping(user.tenantId, p.id);
  return (
    <Page title="Mapping des identifiants" sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Mapping" }]}>
      <div className="page-head">
        <h1>Mapping des identifiants</h1>
        <p>Un mauvais rattachement fausse les prix, les réservations et les planchers sans que rien ne signale d'erreur. Vérifiez que chaque outil désigne bien ce logement, puis confirmez.</p>
      </div>
      <p data-testid="mapping-status"><State role={m.status === "CONFIRMED" ? "sain" : m.status === "INCOMPLETE" ? "violation" : "attention"}>{MAPPING_STATUS_LABEL[m.status]}</State>{m.confirmedAt && <small> · confirmé le {fmtDate(m.confirmedAt.slice(0, 10))}</small>}</p>
      <section aria-labelledby="map-items">
        <h2 id="map-items">Ce que chaque outil désigne</h2>
        <div className="stack" data-testid="mapping-items">
          {m.items.map((i) => (
            <div className="card" key={i.key} data-testid={`mapping-${i.key}`} style={{ padding: 16 }}>
              <div className="row-wrap" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{i.label}{i.required && <span className="req" aria-hidden="true"> *</span>}{i.required && <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}> (obligatoire)</span>}</strong>
                <State role={ROLE[i.state]}>{STATE_LABEL[i.state]}</State>
              </div>
              <p style={{ margin: "6px 0 10px" }}>{i.detail}</p>
              <Link className="btn btn-ghost btn-sm" href={i.fix === "annonces" ? `/logements/${p.id}?tab=annonces` : `/logements/${p.id}?tab=${i.fix}`}><Icon name="sliders" />{FIX_LABEL[i.fix]}<span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}> : {i.label}</span></Link>
            </div>
          ))}
        </div>
      </section>
      {m.checks.length > 0 && (
        <Banner role="attention" title={`${m.checks.length} écart${m.checks.length > 1 ? "s" : ""} à contrôler`} style={{ marginTop: 20 }}>
          <ul data-testid="mapping-checks" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{m.checks.map((c) => <li key={c.id}>{c.message}</li>)}</ul>
        </Banner>
      )}
      <section aria-labelledby="map-confirm" style={{ marginTop: 24 }}>
        <h2 id="map-confirm">Confirmation</h2>
        {m.isDemo ? <p className="section-note">Un logement de démonstration n'a pas de mapping à confirmer.</p>
          : !m.confirmable ? <Banner role="tech" title="Pas encore confirmable">Rattachez d'abord l'annonce PriceLabs : sans elle, le logement n'a ni calendrier ni prix à analyser.</Banner>
          : m.status === "CONFIRMED" ? <p className="section-note">Mapping confirmé. Il sera à reconfirmer dès qu'un identifiant change.</p>
          : <>
            {m.status === "STALE" && <Banner role="attention" title="Un identifiant a changé depuis la dernière confirmation" style={{ marginBottom: 12 }}>Relisez les rattachements ci-dessus avant de reconfirmer.</Banner>}
            <MappingConfirmForm propertyId={p.id} fingerprint={m.fingerprint} hasChecks={m.checks.length > 0} label={m.status === "STALE" ? "Reconfirmer le mapping" : "Confirmer le mapping"} />
          </>}
      </section>
    </Page>
  );
}

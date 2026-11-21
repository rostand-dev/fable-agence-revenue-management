import Link from "next/link";
import { notFound } from "next/navigation";
import { activatePropertyAction } from "@/app/actions/quality";
import { Icon } from "@/components/Icon";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { PROPERTY_STATUS } from "@/lib/labels";
import type { QualityFix } from "@/lib/quality";
import { PortfolioError } from "@/lib/services/portfolio";
import { getQuality } from "@/lib/services/quality";

export const metadata = { title: "Checklist de qualité" };
const FIX = (id: string, k: QualityFix) => ({
  dossier: { href: `/logements/${id}/modifier`, label: "Modifier le dossier" },
  pricelabs: { href: `/logements/${id}?tab=pricelabs`, label: "Ouvrir PriceLabs" },
  superhote: { href: `/logements/${id}?tab=superhote`, label: "Ouvrir SuperHote" },
  couts: { href: `/logements/${id}/couts`, label: "Compléter les coûts" },
  mapping: { href: `/logements/${id}/mapping`, label: "Confirmer le mapping" },
})[k];

/** Checklist de qualité (US-024) : ce qu'il faut pour qu'un logement en observation puisse être activé. */
export default async function Qualite({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let q;
  try { q = await getQuality(user.tenantId, id); } catch (e) { if (e instanceof PortfolioError) notFound(); throw e; }
  const [statusLabel] = PROPERTY_STATUS[q.status] ?? [q.status];
  const blocking = q.items.filter((i) => i.severity === "BLOCKING"), advisory = q.items.filter((i) => i.severity === "ADVISORY");
  const row = (i: (typeof q.items)[number]) => {
    const fix = FIX(id, i.fix);
    return (
      <li key={i.key} data-testid={`quality-${i.key}`} data-ok={i.ok ? "true" : "false"} className="card" style={{ padding: 16, listStyle: "none" }}>
        <div className="row-wrap" style={{ justifyContent: "space-between", alignItems: "baseline", gap: "4px 12px" }}>
          <strong>{i.label}</strong>
          <State role={i.ok ? "sain" : i.severity === "BLOCKING" ? "violation" : "attention"}>{i.ok ? "satisfait" : i.severity === "BLOCKING" ? "bloquant" : "à surveiller"}</State>
        </div>
        <p style={{ margin: "6px 0 10px" }}>{i.detail}</p>
        {!i.ok && <Link className="btn btn-ghost btn-sm" href={fix.href}><Icon name="sliders" />{fix.label}</Link>}
      </li>
    );
  };
  return (
    <Page title="Checklist de qualité" sub={q.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: q.name, href: `/logements/${id}` }, { label: "Checklist de qualité" }]}>
      <div className="page-head">
        <h1>Checklist de qualité</h1>
        <p>Un logement ne passe de l'observation à l'état actif que si tous les points bloquants sont satisfaits. Les points à surveiller n'empêchent pas l'activation.</p>
      </div>
      <p data-testid="quality-status"><State role="neutre">{statusLabel}</State> <State role={q.canActivate ? "sain" : "violation"}>{q.canActivate ? "checklist satisfaite" : `${q.blockers.length} point${q.blockers.length > 1 ? "s" : ""} bloquant${q.blockers.length > 1 ? "s" : ""}`}</State></p>
      <section aria-labelledby="q-block">
        <h2 id="q-block">Points bloquants</h2>
        <ul role="list" className="stack" style={{ margin: 0, padding: 0 }}>{blocking.map(row)}</ul>
      </section>
      <section aria-labelledby="q-adv" style={{ marginTop: 24 }}>
        <h2 id="q-adv">Points à surveiller</h2>
        <ul role="list" className="stack" style={{ margin: 0, padding: 0 }}>{advisory.map(row)}</ul>
      </section>
      <section aria-labelledby="q-act" style={{ marginTop: 28 }}>
        <h2 id="q-act">Activation</h2>
        {q.isDemo ? <Banner role="tech" title="Logement de démonstration">Un logement de démonstration ne s'active pas.</Banner>
          : q.status === "ACTIVE" ? (q.canActivate
              ? <Banner role="sain" title="Logement actif">Ce logement est actif.</Banner>
              : <Banner role="attention" title="Logement actif, mais la checklist n'est plus satisfaite">Ce logement est actif ; corrigez les points bloquants ci-dessus. La checklist est vérifiée à l'activation, puis affichée à jour sur cette page.</Banner>)
          : q.status === "ONBOARDING" ? <Banner role="tech" title="Création en cours">Terminez le parcours de création pour lancer l'observation ; l'activation vient ensuite.</Banner>
          : (
            <ActionForm action={activatePropertyAction} hidden={{ propertyId: id }}>
              {!q.canActivate && <div id="q-act-why"><Banner role="attention" title="Activation impossible pour le moment" style={{ marginBottom: 12 }}>Corrigez les points bloquants ci-dessus.</Banner></div>}
              {q.canActivate
                ? <Submit icon="check" pendingLabel="Activation…">Activer le logement</Submit>
                : <button type="button" className="btn btn-primary" aria-disabled="true" aria-describedby="q-act-why" style={{ opacity: 0.55, cursor: "not-allowed" }}><Icon name="check" />Activer le logement</button>}
            </ActionForm>
          )}
      </section>
    </Page>
  );
}

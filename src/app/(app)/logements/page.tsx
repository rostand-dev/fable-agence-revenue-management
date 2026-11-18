import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Badge, Money, State, Vq } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtMonthShort, todayISO } from "@/lib/dates";
import { missingEconomics } from "@/lib/engine/economics";
import { lastMonths, monthlyKpis } from "@/lib/engine/metrics";
import type { EconomicModel } from "@/lib/engine/types";
import { pct } from "@/lib/format";
import { PROPERTY_STATUS as STATUS } from "@/lib/labels";
import { CADENCE_LABEL, everyLabel, type CadenceLevel } from "@/lib/engine/cadence";
import { CADENCE_ROLE } from "@/components/CadencePanel";
import { listOpportunities, listProperties } from "@/lib/queries";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Banner } from "@/components/ui";
import { FUNNEL_STEPS, resumeStep, stepIndex, stepLabel } from "@/lib/onboarding";

export const metadata = { title: "Logements" };

export default async function Logements({ searchParams }: { searchParams: Promise<{ enregistre?: string }> }) {
  const user = await requireUser();
  const saved = !!(await searchParams).enregistre;
  const [props, opps, resas] = await Promise.all([listProperties(user.tenantId), listOpportunities(user.tenantId, ["OPEN"]), db.select().from(schema.reservations).where(eq(schema.reservations.tenantId, user.tenantId))]);
  const months = lastMonths(todayISO(), 3);
  return (
    <Page title="Logements" sub={`${props.length} logement${props.length > 1 ? "s" : ""}`} crumbs={[{ label: "Logements" }]}>
      <div className="page-head">
        <h1>Vos logements</h1>
        <p>Chaque logement a sa propre stratégie, ses propres planchers et son propre dossier. Les agents, eux, sont les mêmes d'un logement à l'autre.</p>
      </div>
      {saved && <Banner role="sain" title="Saisie enregistrée" style={{ marginBottom: 16 }}>Vous reprendrez la création exactement là où vous vous êtes arrêtée, avec « Reprendre la création ».</Banner>}
      <p style={{ margin: "0 0 18px" }}><Link className="btn btn-primary" href="/logements/nouveau"><Icon name="plus" />Ajouter un logement</Link></p>
      <div className="stack">
        {props.map((p) => {
          const k = monthlyKpis(resas.filter((r) => r.propertyId === p.id), months);
          const nights = k.reduce((a, m) => a + m.nights, 0), avail = k.reduce((a, m) => a + m.available, 0), net = k.reduce((a, m) => a + m.netCents, 0);
          const has = resas.some((r) => r.propertyId === p.id);
          const miss = missingEconomics(p.economics as EconomicModel);
          const [label, fam, ico] = STATUS[p.status] ?? STATUS.ONBOARDING;
          const n = opps.filter((o) => o.propertyId === p.id).length;
          if (p.status === "ONBOARDING" && !p.isDemo) {
            const resume = resumeStep({ identityOk: p.name.length >= 2 && p.city.length >= 2 && !!p.kind, superhoteLinked: !!p.superhote?.rentalId, pricelabsLinked: !!p.pricelabs?.listingId, economicsMissing: miss.length, onboarding: p.onboarding });
            const i = stepIndex(resume) + 1, later = (p.onboarding?.skipped ?? []).filter((k: string) => !(k === "superhote" ? p.superhote?.rentalId : p.pricelabs?.listingId));
            return (
              <Link key={p.id} href={`/logements/${p.id}/creation`} className="idhead" style={{ textDecoration: "none", color: "inherit", marginBottom: 0 }}>
                <div>
                  <h1 style={{ fontSize: 19 }}>{p.name}</h1>
                  <div className="idmeta"><span>{[p.kind, p.city].filter(Boolean).join(" · ") || "type et ville non renseignés"}</span></div>
                  <div className="lcard-progress">
                    <div className="fn-mstep-row"><span>Création : étape {i} sur {FUNNEL_STEPS.length} · {stepLabel(resume)}</span></div>
                    <div className="fn-bar" aria-hidden="true"><i style={{ width: `${Math.round((i / FUNNEL_STEPS.length) * 100)}%` }} /></div>
                  </div>
                </div>
                <div className="idsync">
                  <Badge family="prep" icon="clock">Création en cours</Badge>
                  {later.map((k: string) => <State key={k} role="attention">{k === "superhote" ? "SuperHote" : "PriceLabs"} à faire plus tard</State>)}
                  <span className="btn btn-primary btn-sm"><Icon name="arrow" />Reprendre la création</span>
                </div>
              </Link>
            );
          }
          return (
            <Link key={p.id} href={`/logements/${p.id}`} className="idhead" style={{ textDecoration: "none", color: "inherit", marginBottom: 0 }}>
              <div>
                <h1 style={{ fontSize: 19 }}>{p.name} {p.isDemo && <span className="demo-pill" style={{ verticalAlign: "middle" }}>démo</span>}</h1>
                <div className="idmeta"><span>{[p.kind, p.city].filter(Boolean).join(" · ") || "type et ville non renseignés"}</span><span>{p.capacity ? `${p.capacity} voyageurs` : "capacité inconnue"}</span><span>stratégie v{p.strategyVersion}</span></div>
                <div className="row-wrap" style={{ marginTop: 12, gap: "8px 22px" }}>
                  <span className="amount"><span className="gauge-label">Occupation · {fmtMonthShort(months[0])} → {fmtMonthShort(months[2])}</span><span className="amount-value">{has ? pct(nights / avail) : <Vq>inconnue</Vq>}</span></span>
                  <span className="amount"><span className="gauge-label">Revenu net · {fmtMonthShort(months[0])} → {fmtMonthShort(months[2])}</span><span className="amount-value">{has ? <Money cents={net} /> : <Vq>inconnu</Vq>}</span></span>
                  <span className="amount"><span className="gauge-label">Situations ouvertes</span><span className="amount-value">{n}</span></span>
                </div>
              </div>
              <div className="idsync">
                <Badge family={fam} icon={ico}>{p.status === "ONBOARDING" && !p.isDemo ? "Saisie à reprendre" : label}</Badge>
                {miss.length > 0 ? <State role="attention">{miss.length} donnée{miss.length > 1 ? "s" : ""} manquante{miss.length > 1 ? "s" : ""}</State> : <State role="sain">Planchers calculés</State>}
                {p.cadence?.level && <State role={CADENCE_ROLE[p.cadence.level as CadenceLevel]}>{CADENCE_LABEL[p.cadence.level as CadenceLevel]} · revue {everyLabel(p.cadence.reviewEveryH)}</State>}
              </div>
            </Link>
          );
        })}
        {props.length === 0 && <div className="empty"><h3>Aucun logement</h3><p>Ajoutez votre premier logement pour que l'équipe puisse commencer son onboarding.</p></div>}
      </div>
    </Page>
  );
}

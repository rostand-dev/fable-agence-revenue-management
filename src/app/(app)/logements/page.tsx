import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Badge, Money, State, Vq } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { missingEconomics } from "@/lib/engine/economics";
import { lastMonths, monthlyKpis } from "@/lib/engine/metrics";
import type { EconomicModel } from "@/lib/engine/types";
import { pct } from "@/lib/format";
import { PROPERTY_STATUS as STATUS } from "@/lib/labels";
import { listOpportunities, listProperties } from "@/lib/queries";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export const metadata = { title: "Logements" };

export default async function Logements() {
  const user = await requireUser();
  const [props, opps, resas] = await Promise.all([listProperties(user.tenantId), listOpportunities(user.tenantId, ["OPEN"]), db.select().from(schema.reservations).where(eq(schema.reservations.tenantId, user.tenantId))]);
  const months = lastMonths(todayISO(), 3);
  return (
    <Page title="Logements" sub={`${props.length} logement${props.length > 1 ? "s" : ""}`} crumbs={[{ label: "Logements" }]}>
      <div className="page-head">
        <h1>Vos logements</h1>
        <p>Chaque logement a sa propre stratégie, ses propres planchers et son propre dossier. Les agents, eux, sont les mêmes d'un logement à l'autre.</p>
      </div>
      <p style={{ margin: "0 0 18px" }}><Link className="btn btn-primary" href="/logements/nouveau"><Icon name="plus" />Ajouter un logement</Link></p>
      <div className="stack">
        {props.map((p) => {
          const k = monthlyKpis(resas.filter((r) => r.propertyId === p.id), months);
          const nights = k.reduce((a, m) => a + m.nights, 0), avail = k.reduce((a, m) => a + m.available, 0), net = k.reduce((a, m) => a + m.netCents, 0);
          const has = resas.some((r) => r.propertyId === p.id);
          const miss = missingEconomics(p.economics as EconomicModel);
          const [label, fam, ico] = STATUS[p.status] ?? STATUS.ONBOARDING;
          const n = opps.filter((o) => o.propertyId === p.id).length;
          return (
            <Link key={p.id} href={`/logements/${p.id}`} className="idhead" style={{ textDecoration: "none", color: "inherit", marginBottom: 0 }}>
              <div>
                <h1 style={{ fontSize: 19 }}>{p.name} {p.isDemo && <span className="demo-pill" style={{ verticalAlign: "middle" }}>démo</span>}</h1>
                <div className="idmeta"><span>{[p.kind, p.city].filter(Boolean).join(" · ") || "type et ville non renseignés"}</span><span>{p.capacity ? `${p.capacity} voyageurs` : "capacité inconnue"}</span><span>stratégie v{p.strategyVersion}</span></div>
                <div className="row-wrap" style={{ marginTop: 12, gap: "8px 22px" }}>
                  <span className="amount"><span className="gauge-label">Occupation · 3 mois</span><span className="amount-value">{has ? pct(nights / avail) : <Vq>inconnue</Vq>}</span></span>
                  <span className="amount"><span className="gauge-label">Revenu net · 3 mois</span><span className="amount-value">{has ? <Money cents={net} /> : <Vq>inconnu</Vq>}</span></span>
                  <span className="amount"><span className="gauge-label">Situations ouvertes</span><span className="amount-value">{n}</span></span>
                </div>
              </div>
              <div className="idsync">
                <Badge family={fam} icon={ico}>{p.status === "ONBOARDING" && !p.isDemo ? "Saisie à reprendre" : label}</Badge>
                {miss.length > 0 ? <State role="attention">{miss.length} donnée{miss.length > 1 ? "s" : ""} manquante{miss.length > 1 ? "s" : ""}</State> : <State role="sain">Planchers calculés</State>}
              </div>
            </Link>
          );
        })}
        {props.length === 0 && <div className="empty"><h3>Aucun logement</h3><p>Ajoutez votre premier logement pour que l'équipe puisse commencer son onboarding.</p></div>}
      </div>
    </Page>
  );
}

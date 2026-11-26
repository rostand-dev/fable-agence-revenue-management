import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { ListingsPanel } from "@/components/ListingsPanel";
import { ManageMenu } from "@/components/ManageMenu";
import { PriceLabsPanel } from "@/components/PriceLabsPanel";
import { SectionSwitcher } from "@/components/SectionSwitcher";
import { SuperhotePanel } from "@/components/SuperhotePanel";
import { TodoCard } from "@/components/TodoCard";
import { Badge, Banner, State } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { fmtDate, fmtMonth, todayISO } from "@/lib/dates";
import { missingEconomics } from "@/lib/engine/economics";
import { lastMonths, monthlyKpis } from "@/lib/engine/metrics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { badgeHref, pricelabsBadge, superhoteBadge } from "@/lib/integrations/connection-badge";
import { PROPERTY_STATUS as STATUS } from "@/lib/labels";
import { PROPERTY_SECTIONS, sectionHref, sectionOfTab } from "@/lib/nav";
import { can } from "@/lib/rbac";
import { hubByTab, HUBS, hubScreens, isLaunched } from "@/lib/property-hubs";
import { linkedElsewhere } from "@/lib/services/pricelabs-sync";
import { listListings } from "@/lib/services/portfolio";
import { loadEngineInput } from "@/lib/services/review";
import { getSnapshotState } from "@/lib/services/snapshots";
import { rentalLinkedElsewhere } from "@/lib/services/superhote-sync";
import { webhookStatus } from "@/lib/services/superhote-webhook";
import { Apercu } from "./_sections/Apercu";
import { Calendrier } from "./_sections/Calendrier";
import type { Fiche, FicheParams } from "./_sections/context";
import { Economie } from "./_sections/Economie";
import { Historique } from "./_sections/Historique";
import { Hub } from "./_sections/Hubs";
import { Performance } from "./_sections/Performance";
import { QualiteDonnees } from "./_sections/QualiteDonnees";
import { Canaux, StrategieEnVigueur } from "./_sections/Strategie";
import { todoItems } from "./_sections/todo";
import { RightsNotice } from "@/components/Rights";

async function noChannelRows(propertyId: string, overrides: Record<string, string>) {
  const rows = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, propertyId));
  return rows.filter((r) => overrides[r.externalId] || (r.channel === "INCONNU" && r.status === "CONFIRMED")).sort((a, b) => a.checkIn.localeCompare(b.checkIn))
    .map((r) => ({ externalId: r.externalId, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, grossRoomCents: r.grossRoomCents, commissionCents: r.commissionCents, choice: overrides[r.externalId] ?? "" }));
}

/**
 * Fiche d'un logement. Chaque écran garde son adresse `?tab=` ; les hubs (`?tab=hub-…`) rassemblent les écrans d'une rubrique.
 * Le contenu de chaque écran est dans `_sections/`.
 */
export default async function Logement({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<FicheParams> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const tab = sp.tab ?? "apercu";
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p) notFound();
  const today = todayISO(), now = new Date();
  const input = (await loadEngineInput(user.tenantId, p.id, today, now))!;
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.propertyId, p.id), eq(schema.opportunities.status, "OPEN")));
  const model = p.economics as EconomicModel;
  const miss = missingEconomics(model);
  // pendant la création, tout se complète dans le parcours guidé : une seule bannière, qui y ramène
  const onboarding = !p.isDemo && p.status === "ONBOARDING";
  const [label, fam, ico] = STATUS[p.status] ?? STATUS.ONBOARDING;
  const months = lastMonths(today, 12), kpis = monthlyKpis(input.resas, months);
  const hasHistory = input.resas.length > 0, hasCal = input.days.length > 0;
  const first3 = kpis.slice(0, 3).reduce((a, k) => a + k.netRevpanCents, 0) / 3, last3 = kpis.slice(-3).reduce((a, k) => a + k.netRevpanCents, 0) / 3;
  const trend = !hasHistory || kpis.some((k) => k.netIncomplete) ? null : last3 > first3 * 1.05 ? "croissante" : last3 < first3 * 0.95 ? "décroissante" : "stable";
  const fiche: Fiche = {
    user, p, sp, today, now, input, opps, model, strat: p.strategy as Strategy, names: user.settings.agentNames ?? null, miss, onboarding, hasHistory, hasCal,
    months, kpis, period: `${fmtMonth(months[0])} → ${fmtMonth(months[months.length - 1])}`, trend,
  };
  const [owner] = p.ownerId ? await db.select({ name: schema.owners.name }).from(schema.owners).where(and(eq(schema.owners.id, p.ownerId), eq(schema.owners.tenantId, user.tenantId))) : [];
  const section = sectionOfTab(tab);
  const hub = hubByTab(tab);
  const canDelete = can(user.role, "property.delete"), canManage = can(user.role, "property.manage");
  // lien de retour d'un écran vers sa rubrique (les hubs et les écrans de premier niveau n'en ont pas)
  const parent = tab === "performance" ? { href: `/logements/${p.id}`, label: "Vue d'ensemble" }
    : !hub && HUBS.some((h) => h.key === section.key) ? { href: sectionHref(p.id, section.key), label: section.label } : null;
  const sections = PROPERTY_SECTIONS.map((s) => {
    const h = HUBS.find((x) => x.key === s.key);
    return { key: s.key, label: s.label, href: sectionHref(p.id, s.key), links: h ? hubScreens(h.key, p).map((x) => ({ label: x.label, href: x.href })) : [] };
  });

  return (
    <Page title={p.name} sub={`${[p.kind, p.city].filter(Boolean).join(" · ") || "dossier en cours de saisie"} · stratégie v${p.strategyVersion}`} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name }]}>
      <div className="idhead">
        <div>
          <h1>{p.name} {p.isDemo && <span className="demo-pill" style={{ verticalAlign: "middle" }}>démonstration</span>}</h1>
          <div className="idmeta"><span>{p.kind || "type non renseigné"}{p.bedrooms ? ` · ${p.bedrooms} chambres` : ""}{p.capacity ? ` · ${p.capacity} voyageurs` : ""}</span><span>{p.city || "ville non renseignée"}</span><span>{p.profile?.positioning ?? "positionnement non renseigné"}</span>{owner && <span data-testid="property-owner">propriétaire : {owner.name}</span>}</div>
        </div>
        <div className="idsync"><Badge family={fam} icon={ico}>{label}</Badge>{([["pricelabs", pricelabsBadge(p.pricelabs, p.isDemo)], ["superhote", superhoteBadge(p.superhote, p.isDemo)]] as const).map(([k, b]) => b && <Link key={k} href={badgeHref(k, p.id, p.status, canManage)} scroll={false} className="state-link"><State role={b.role}>{b.label}</State></Link>)}<span className="read-date"><Icon name="clock" />{hasCal ? `Calendrier lu jusqu'au ${fmtDate(input.days[input.days.length - 1].date)}` : "Aucun calendrier lu"}</span></div>
      </div>
      {p.isDemo && <Banner role="tech" title="Logement de démonstration" style={{ marginBottom: 16 }}>Réservations, prix, marché et coûts sont synthétiques. Les coûts et commissions affichés sont des hypothèses à remplacer par vos valeurs lors de l'onboarding de votre propre logement.</Banner>}
      {onboarding && <Banner role="tech" title="Création du logement en cours" style={{ marginBottom: 16 }}>Ce logement n'est pas encore lancé.{canManage && " Reprenez le parcours de création là où vous l'avez laissé."} {(canManage || canDelete) && <span style={{ display: "block", marginTop: 10 }}>{canManage && <Link className="btn btn-primary btn-sm" href={`/logements/${p.id}/creation`}><Icon name="arrow" />Reprendre la création</Link>}{canDelete && <> <Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/supprimer`}><Icon name="cross" />Supprimer ce brouillon</Link></>}</span>}</Banner>}
      {sp.lance && <Banner role="sain" title="Observation lancée" style={{ marginBottom: 16 }}>Le dossier est complet : l'équipe lit vos données et vous proposera ses premières situations, sans rien appliquer sans votre accord.</Banner>}
      <TodoCard items={todoItems(fiche, tab)} />
      <div className="fiche-bar">
        <Suspense fallback={null}><SectionSwitcher property={p.name} sections={sections} active={section.key} tab={tab} /></Suspense>
        {isLaunched(p) && <Suspense fallback={null}><ManageMenu propertyId={p.id} canEdit={canManage} canDelete={canDelete} /></Suspense>}
      </div>
      {parent && <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={parent.href}><Icon name="back" />{parent.label}</Link></p>}

      {section.key === "apercu" && tab !== "performance" && <Apercu {...fiche} />}
      {tab === "performance" && <Performance {...fiche} />}
      {hub && <Hub hub={hub.key} fiche={fiche} />}
      {tab === "calendrier" && <Calendrier {...fiche} />}
      {tab === "strategie" && <StrategieEnVigueur {...fiche} />}
      {tab === "canaux" && <Canaux {...fiche} />}
      {tab === "economie" && <Economie {...fiche} />}
      {!p.isDemo && (tab === "annonces" || tab === "pricelabs" || tab === "superhote") && <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/mapping`}><Icon name="link" />Mapping des identifiants</Link></p>}
      {!p.isDemo && (tab === "annonces" || tab === "pricelabs" || tab === "superhote") && <RightsNotice need="property.manage" />}
      {tab === "annonces" && <ListingsPanel propertyId={p.id} listings={await listListings(user.tenantId, p.id)} editable={!p.isDemo} />}
      {tab === "pricelabs" && <PriceLabsPanel costsMissing={miss.length} propertyId={p.id} propertyName={p.name} propertyCity={p.city} isDemo={p.isDemo} pl={p.pricelabs ?? null} error={sp.erreur} taken={!p.isDemo ? Object.fromEntries(await linkedElsewhere(user.tenantId, p.id)) : {}} noChannel={!p.isDemo ? await noChannelRows(p.id, p.pricelabs?.overrides ?? {}) : []} snapshots={!p.isDemo && p.pricelabs?.apiKeyEnc ? await getSnapshotState(user.tenantId, p.id, { limit: 5 }) : null} />}
      {tab === "superhote" && <SuperhotePanel propertyId={p.id} propertyName={p.name} propertyCity={p.city} isDemo={p.isDemo} sh={p.superhote ?? null} plLinked={!!p.pricelabs?.listingId} taken={!p.isDemo ? Object.fromEntries(await rentalLinkedElsewhere(user.tenantId, p.id)) : {}} error={sp.erreurSh} webhook={!p.isDemo && p.superhote?.apiKeyEnc ? await webhookStatus(user.tenantId, p.id) : undefined} />}
      {tab === "historique" && <Historique {...fiche} />}
      {tab === "donnees" && <QualiteDonnees {...fiche} />}
    </Page>
  );
}

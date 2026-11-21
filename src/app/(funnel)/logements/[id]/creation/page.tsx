import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { CostWizard } from "@/components/CostWizard";
import { StepTop } from "@/components/StepTop";
import { FunnelHeader, FunnelStepper, savedLabel } from "@/components/Funnel";
import { ConnectStep, LogementStep, ReglesStep, stepHref, VerificationStep } from "@/components/FunnelSteps";
import { db, schema } from "@/db";
import { agentName } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { answersFromModel } from "@/lib/engine/costs";
import { missingEconomics } from "@/lib/engine/economics";
import { lastMonths, medianLos, monthlyKpis } from "@/lib/engine/metrics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { funnelView, isStep, launchBlockers, resumeStep, type FunnelFacts, type StepKey } from "@/lib/onboarding";
import type { ChannelMarkup } from "@/lib/pricing/published";
import { linkedElsewhere } from "@/lib/services/pricelabs-sync";
import { listOwners } from "@/lib/services/portfolio";
import { rentalLinkedElsewhere } from "@/lib/services/superhote-sync";

export const metadata = { title: "Création d'un logement" };

/** Canaux réellement vus dans les réservations, pour préremplir les majorations. */
const SEEN_LABEL: Record<string, string> = { AIRBNB: "Airbnb", BOOKING: "Booking", DIRECT: "Direct" };

export default async function Creation({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ etape?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  if (p.status !== "ONBOARDING") redirect(`/logements/${p.id}`);
  const model = p.economics as EconomicModel, strat = (p.strategy ?? {}) as Strategy;
  const miss = missingEconomics(model);
  const facts: FunnelFacts = { identityOk: p.name.length >= 2 && p.city.length >= 2 && !!p.kind, superhoteLinked: !!p.superhote?.rentalId, pricelabsLinked: !!p.pricelabs?.listingId, economicsMissing: miss.length, onboarding: p.onboarding };
  const asked = (await searchParams).etape;
  const resume = resumeStep(facts);
  const step: StepKey = isStep(asked) ? asked : resume;
  // une étape encore jamais atteinte ne s'ouvre pas par l'adresse : redirection vers l'étape où reprendre
  if (!funnelView(facts, resume).find((v) => v.key === step)!.reachable) redirect(stepHref(p.id, resume));
  const steps = funnelView(facts, step);
  const ines = agentName("onboarding", user.settings.agentNames);
  const title = `Nouveau logement · ${p.name}`;

  let body: React.ReactNode;
  if (step === "logement") {
    body = <LogementStep p={{ id: p.id, name: p.name, city: p.city, kind: p.kind, bedrooms: p.bedrooms, capacity: p.capacity, positioning: strat.positioning ?? p.profile?.positioning ?? "", objective: strat.objective ?? "" }} owners={await listOwners(user.tenantId)} ownerId={p.ownerId} />;
  } else if (step === "superhote") {
    const taken = await rentalLinkedElsewhere(user.tenantId, p.id);
    const cands = ((p.superhote?.candidates ?? []) as any[]).map((c) => ({ id: String(c.id), label: c.name, detail: [c.city, c.capacity ? `${c.capacity} voyageurs` : null, `identifiant ${c.id}`].filter(Boolean).join(" · "), taken: taken.get(String(c.id)) }));
    body = <ConnectStep kind="superhote" propertyId={p.id} propertyName={p.name} propertyCity={p.city} conn={p.superhote ?? null} cands={cands} ines={ines} />;
  } else if (step === "pricelabs") {
    const taken = await linkedElsewhere(user.tenantId, p.id);
    const cands = ((p.pricelabs?.candidates ?? []) as any[]).map((c) => ({ id: String(c.id), label: c.name, detail: [c.city, c.bedrooms !== null && c.bedrooms !== undefined ? `${c.bedrooms} chambre${c.bedrooms > 1 ? "s" : ""}` : null, c.pms, `identifiant ${c.id}`].filter(Boolean).join(" · "), taken: taken.get(`${c.id}|${c.pms}`) }));
    body = <ConnectStep kind="pricelabs" propertyId={p.id} propertyName={p.name} propertyCity={p.city} conn={p.pricelabs ?? null} cands={cands} ines={ines} plMissingNote={!p.pricelabs?.listingId} />;
  } else if (step === "regles") {
    let markups = (p.channelMarkups ?? []) as ChannelMarkup[], seenNote: string | undefined;
    if (markups.length === 0) {
      const rows = await db.select({ channel: schema.reservations.channel }).from(schema.reservations).where(and(eq(schema.reservations.propertyId, p.id), eq(schema.reservations.status, "CONFIRMED")));
      const count = new Map<string, number>();
      for (const r of rows) if (SEEN_LABEL[r.channel]) count.set(r.channel, (count.get(r.channel) ?? 0) + 1);
      const seen = [...count.entries()].sort((a, b) => b[1] - a[1]);
      if (seen.length) {
        markups = seen.map(([c]) => ({ key: c.toLowerCase(), label: SEEN_LABEL[c], pct: null }));
        seenNote = `Canaux préremplis d'après vos réservations : ${seen.map(([c, k]) => `${SEEN_LABEL[c]} (${k})`).join(", ")}.`;
      }
    }
    body = <ReglesStep propertyId={p.id} minStay={strat.minStay ?? null} markups={markups} seenNote={seenNote} />;
  } else if (step === "couts") {
    const resas = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, p.id));
    const k = monthlyKpis(resas, lastMonths(todayISO(), 12)).filter((m) => m.nights > 0);
    const nightsSold = k.length ? k.reduce((a, m) => a + m.nights, 0) : null;
    body = (
      <>
        <div className="fn-head"><h1>Coûts et seuils</h1><p>Huit questions courtes avec {ines}. Si vous ne savez pas, laissez vide ou donnez une estimation provisoire : vos réponses sont enregistrées à chaque question.</p></div>
        <CostWizard propertyId={p.id} propertyName={p.name} startAt={p.onboarding?.costQ ?? 0} initial={answersFromModel(model)} doneHref={stepHref(p.id, "verification")} quitHref="/logements?enregistre=1"
          hints={{ ines, observed: p.pricelabs?.lastSync?.observedCommission ?? {}, observedSh: p.superhote?.lastSync?.observedCommission ?? {}, observedFeeSh: p.superhote?.lastSync?.observedPaymentFee ?? null, nightsSold, monthsCovered: k.length || null, avgStay: medianLos(resas), minPriceCents: strat.minPriceCents ?? null }} />
      </>
    );
  } else {
    const blockers = launchBlockers(facts);
    const markups = (p.channelMarkups ?? []) as ChannelMarkup[];
    const prov = model.provisional ?? [];
    const checks = [
      { key: "logement" as const, ok: facts.identityOk, summary: facts.identityOk ? [p.name, p.kind, p.city, p.bedrooms ? `${p.bedrooms} chambre${p.bedrooms > 1 ? "s" : ""}` : null, p.capacity ? `${p.capacity} voyageurs` : null].filter(Boolean).join(" · ") : "Nom, ville et type à renseigner" },
      { key: "superhote" as const, ok: facts.superhoteLinked, warn: true, summary: facts.superhoteLinked ? `Logement ${p.superhote?.rentalName ?? p.superhote?.rentalId} rattaché` : "À faire plus tard : en attendant, les réservations sont lues via PriceLabs" },
      { key: "pricelabs" as const, ok: facts.pricelabsLinked, summary: facts.pricelabsLinked ? `Annonce ${p.pricelabs?.listingName ?? p.pricelabs?.listingId} rattachée${p.pricelabs?.lastSync?.days ? ` · grille lue sur ${p.pricelabs.lastSync.days} jours` : ""}` : "Indispensable pour lancer l'observation : aucune revue n'est possible sans calendrier de prix" },
      { key: "regles" as const, ok: (p.onboarding?.done ?? []).includes("regles"), warn: true, summary: `Séjour minimum ${strat.minStay ? strat.minStay + " nuit" + (strat.minStay > 1 ? "s" : "") : "inconnu"} · ${markups.length ? "majorations " + markups.map((m) => `${m.label} ${m.pct === null ? "inconnue" : String(m.pct).replace(".", ",") + " %"}`).join(", ") : "aucune majoration saisie"}` },
      { key: "couts" as const, ok: miss.length === 0, summary: miss.length === 0 ? `Planchers calculés${prov.length ? ` · ${prov.length} valeur${prov.length > 1 ? "s" : ""} provisoire${prov.length > 1 ? "s" : ""} à confirmer` : ""}` : `Il manque : ${miss.join(", ")}` },
    ];
    body = <VerificationStep propertyId={p.id} checks={checks} blockers={blockers} ines={ines} shMissing={!facts.superhoteLinked} />;
  }

  return (
    <>
      <FunnelHeader title={title} saved={savedLabel(p.onboarding?.savedAt)} quit="form" />
      <main className={`fn-wrap${step === "couts" ? " is-wide" : ""}`} id="contenu">
        <FunnelStepper steps={steps} href={(k) => stepHref(p.id, k)} />
        <StepTop stepKey={step} />
        {/* une étape = un arbre neuf : rien (message d'erreur, saisie) ne passe d'une étape à l'autre */}
        <div key={step}>{body}</div>
      </main>
    </>
  );
}

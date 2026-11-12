import { createPropertyAction, updatePropertyAction } from "@/app/actions/settings";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { ActionForm, Submit } from "./forms";
import { PriceLabsGuide } from "./PriceLabsGuide";
import { Banner } from "./ui";

type F = { name: string; label: string; help?: string; req?: boolean; unit?: string; full?: boolean; numeric?: boolean };
const SECTIONS: { title: string; note: string; fields: F[] }[] = [
  { title: "1 · Le logement", note: "Identité et capacité.", fields: [
    { name: "name", label: "Nom du logement", req: true }, { name: "city", label: "Ville", req: true }, { name: "kind", label: "Type (T2, T3, maison…)", req: true },
    { name: "bedrooms", label: "Chambres", numeric: true }, { name: "capacity", label: "Voyageurs maximum", numeric: true },
    { name: "positioning", label: "Clientèle visée", help: "Par exemple : professionnels en semaine, familles le week-end.", full: true },
    { name: "objective", label: "Votre objectif", help: "Par exemple : +20 % de chiffre d'affaires sur un an, sans sacrifier le prix à la nuit.", full: true },
  ] },
  { title: "2 · Commissions par canal", note: "Relevez-les sur vos relevés de versement, pas de mémoire.", fields: [
    { name: "airbnbCommission", label: "Commission Airbnb", unit: "%" }, { name: "bookingCommission", label: "Commission Booking.com", unit: "%" },
    { name: "bookingPaymentFee", label: "Frais de paiement Booking.com", unit: "%", help: "Laissez vide si vous n'utilisez pas les paiements par Booking.com." },
  ] },
  { title: "3 · Coûts", note: "Ce que coûte réellement un séjour et une nuit occupée.", fields: [
    { name: "cleaningFee", label: "Frais de ménage facturés au voyageur", unit: "€" }, { name: "cleaningCost", label: "Coût réel du ménage", unit: "€" },
    { name: "linenCost", label: "Linge et consommables par séjour", unit: "€" }, { name: "variableCost", label: "Coûts variables par nuit occupée", unit: "€", help: "Énergie, eau, consommables." },
  ] },
  { title: "4 · Vos seuils", note: "Ils fondent les planchers : sous le premier, l'auditeur oppose son veto.", fields: [
    { name: "hardContribution", label: "Contribution minimale absolue par nuit", unit: "€", help: "Ce qu'une nuit doit vous laisser au minimum, coûts et commissions déduits." },
    { name: "strategyContribution", label: "Contribution de sécurité par nuit", unit: "€", help: "En dessous, une validation commentée vous est demandée." },
    { name: "targetContribution", label: "Contribution visée par nuit", unit: "€" },
  ] },
  { title: "5 · Séjour minimum", note: "Les prix de base, minimum et maximum sont lus directement dans PriceLabs.", fields: [
    { name: "minStay", label: "Séjour minimum habituel", unit: "nuits" },
  ] },
];

type Existing = { id: string; name: string; city: string; kind: string; bedrooms: number | null; capacity: number | null; economics: EconomicModel; strategy: Strategy; profile: Record<string, any>; hasKey: boolean };
const n = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
const e = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : String(cents / 100).replace(".", ","));

/** Une valeur inconnue repart vide ; rien n'est prérempli à la place du propriétaire. */
export function valuesOf(p: Existing): Record<string, string> {
  const m = p.economics ?? ({} as EconomicModel), s = p.strategy ?? ({} as Strategy);
  return {
    name: p.name === "Logement sans nom" ? "" : p.name, city: p.city, kind: p.kind, bedrooms: n(p.bedrooms), capacity: n(p.capacity), positioning: s.positioning ?? p.profile?.positioning ?? "", objective: s.objective ?? "",
    airbnbCommission: n(m.channels?.AIRBNB?.commissionPct), bookingCommission: n(m.channels?.BOOKING?.commissionPct), bookingPaymentFee: m.channels?.BOOKING ? n(m.channels.BOOKING.paymentFeePct) : "",
    cleaningFee: e(m.cleaningFeeChargedCents), cleaningCost: e(m.cleaningCostCents), linenCost: e(m.linenCostCents), variableCost: e(m.nightlyVariableCostCents),
    hardContribution: e(m.hardContributionPerNightCents), strategyContribution: e(m.strategyContributionPerNightCents), targetContribution: e(m.targetContributionPerNightCents), minStay: n(s.minStay),
  };
}

/** Formulaire de dossier logement, partagé entre la création et la reprise. Deux sorties : enregistrer pour plus tard, ou valider. */
export function PropertyForm({ existing }: { existing?: Existing }) {
  const v = existing ? valuesOf(existing) : {};
  const total = SECTIONS.flatMap((s) => s.fields).length, filled = Object.values(v).filter((x) => x !== "").length;
  return (
    <ActionForm action={existing ? updatePropertyAction : createPropertyAction} hidden={existing ? { propertyId: existing.id } : undefined}>
      {existing && <p className="muted" style={{ margin: "0 0 4px" }}>{filled} champ{filled > 1 ? "s" : ""} renseigné{filled > 1 ? "s" : ""} sur {total}. Les champs vides restent « inconnus ».</p>}
      {SECTIONS.map((s) => (
        <section className="section" key={s.title} style={{ marginTop: 28 }}>
          <h2>{s.title}</h2><p className="section-note">{s.note}</p>
          <div className="form-grid">
            {s.fields.map((f) => (
              <div className="field" key={f.name} style={f.full ? { gridColumn: "1 / -1" } : undefined}>
                <label htmlFor={f.name}>{f.label}{f.unit && <span className="muted"> ({f.unit})</span>}{f.req && <span className="req" aria-hidden="true">*</span>}</label>
                <input id={f.name} name={f.name} type="text" inputMode={f.unit || f.numeric ? "decimal" : undefined} required={f.req} defaultValue={v[f.name] ?? ""} aria-describedby={f.help ? f.name + "-h" : undefined} placeholder={f.req ? undefined : "inconnu si vide"} />
                {f.help && <span className="help" id={f.name + "-h"}>{f.help}</span>}
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="section" style={{ marginTop: 28 }}>
        <h2>6 · Connexion PriceLabs</h2>
        {existing?.hasKey ? (
          <p className="section-note">Une clé PriceLabs est déjà enregistrée pour ce logement. Elle se gère dans sa fiche, onglet PriceLabs.</p>
        ) : (
          <>
            <p className="section-note">La clé est rattachée à ce logement. Elle permet de lire sa grille de prix, son marché et ses réservations. Vous pouvez aussi l'ajouter plus tard depuis la fiche du logement.</p>
            <div className="field" style={{ marginBottom: 12 }}>
              <label htmlFor="pricelabsKey">Clé API PriceLabs</label>
              <input id="pricelabsKey" name="pricelabsKey" type="password" autoComplete="off" spellCheck={false} placeholder="collez la clé ici" aria-describedby="pricelabsKey-h" />
              <span className="help" id="pricelabsKey-h">Vérifiée auprès de PriceLabs à l'enregistrement, puis chiffrée. Jamais réaffichée en entier.</span>
            </div>
            <PriceLabsGuide />
          </>
        )}
      </section>
      <Banner role="tech" title="Deux façons de terminer" style={{ margin: "28px 0 18px" }}>
        <strong>Enregistrer et reprendre plus tard</strong> garde votre saisie telle quelle, sans champ obligatoire : vous la retrouvez dans Logements. <strong>Valider le dossier</strong> demande le nom, la ville et le type ; s'il est complet, les planchers sont calculés et le logement entre en période d'observation.
      </Banner>
      <div className="row-wrap">
        <Submit icon="check" name="intent" value="final" pendingLabel="Enregistrement…">{existing ? "Valider le dossier" : "Créer le dossier et calculer les planchers"}</Submit>
        <Submit className="btn btn-ghost" icon="clock" name="intent" value="draft" formNoValidate pendingLabel="Enregistrement…">Enregistrer et reprendre plus tard</Submit>
      </div>
    </ActionForm>
  );
}

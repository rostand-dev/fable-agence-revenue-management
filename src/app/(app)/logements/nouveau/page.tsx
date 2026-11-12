import { createPropertyAction } from "@/app/actions/settings";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, Byline } from "@/components/ui";
import { PriceLabsGuide } from "@/components/PriceLabsGuide";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Ajouter un logement" };
type F = { name: string; label: string; help?: string; type?: string; req?: boolean; unit?: string; full?: boolean };
const SECTIONS: { title: string; note: string; fields: F[] }[] = [
  { title: "1 · Le logement", note: "Identité et capacité.", fields: [
    { name: "name", label: "Nom du logement", req: true }, { name: "city", label: "Ville", req: true }, { name: "kind", label: "Type (T2, T3, maison…)", req: true },
    { name: "bedrooms", label: "Chambres", type: "number" }, { name: "capacity", label: "Voyageurs maximum", type: "number" },
    { name: "positioning", label: "Clientèle visée", help: "Par exemple : professionnels en semaine, familles le week-end.", full: true },
    { name: "objective", label: "Votre objectif", help: "Par exemple : +20 % de chiffre d'affaires sur un an, sans sacrifier le prix à la nuit.", full: true },
  ] },
  { title: "2 · Commissions par canal", note: "Relevez-les sur vos relevés de versement, pas de mémoire.", fields: [
    { name: "airbnbCommission", label: "Commission Airbnb", unit: "%", type: "number" }, { name: "bookingCommission", label: "Commission Booking.com", unit: "%", type: "number" },
    { name: "bookingPaymentFee", label: "Frais de paiement Booking.com", unit: "%", type: "number", help: "Laissez vide si vous n'utilisez pas les paiements par Booking.com." },
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
    { name: "minStay", label: "Séjour minimum habituel", unit: "nuits", type: "number" },
  ] },
];

export default async function Nouveau() {
  const user = await requireUser();
  return (
    <Page title="Ajouter un logement" sub="Onboarding" crumbs={[{ label: "Logements", href: "/logements" }, { label: "Ajouter" }]}>
      <div className="page-head">
        <h1>Onboarding d'un logement</h1>
        <p>Ces informations permettent de calculer vos planchers économiques par canal et par durée de séjour. Un champ laissé vide reste « inconnu » : il n'est jamais remplacé par zéro, et ce qui en dépend est mis en attente.</p>
        <p style={{ marginTop: 10 }}><Byline agent="onboarding" names={user.settings.agentNames} what="constitue le dossier avec vous" /></p>
      </div>
      <ActionForm action={createPropertyAction}>
        {SECTIONS.map((s) => (
          <section className="section" key={s.title} style={{ marginTop: 28 }}>
            <h2>{s.title}</h2><p className="section-note">{s.note}</p>
            <div className="form-grid">
              {s.fields.map((f) => (
                <div className="field" key={f.name} style={f.full ? { gridColumn: "1 / -1" } : undefined}>
                  <label htmlFor={f.name}>{f.label}{f.unit && <span className="muted"> ({f.unit})</span>}{f.req && <span className="req" aria-hidden="true">*</span>}</label>
                  <input id={f.name} name={f.name} type="text" inputMode={f.unit || f.type === "number" ? "decimal" : undefined} required={f.req} aria-describedby={f.help ? f.name + "-h" : undefined} placeholder={f.req ? undefined : "inconnu si vide"} />
                  {f.help && <span className="help" id={f.name + "-h"}>{f.help}</span>}
                </div>
              ))}
            </div>
          </section>
        ))}
        <section className="section" style={{ marginTop: 28 }}>
          <h2>6 · Connexion PriceLabs</h2>
          <p className="section-note">La clé est rattachée à ce logement. Elle permet de lire sa grille de prix, son marché et ses réservations. Vous pouvez aussi l'ajouter plus tard depuis la fiche du logement.</p>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="pricelabsKey">Clé API PriceLabs</label>
            <input id="pricelabsKey" name="pricelabsKey" type="password" autoComplete="off" spellCheck={false} placeholder="collez la clé ici" aria-describedby="pricelabsKey-h" />
            <span className="help" id="pricelabsKey-h">Vérifiée auprès de PriceLabs à la création, puis chiffrée. Jamais réaffichée en entier.</span>
          </div>
          <PriceLabsGuide />
        </section>
        <Banner role="tech" title="Et ensuite ?" style={{ margin: "28px 0 18px" }}>Dossier complet : le logement entre en période d'observation — l'équipe recommande, rien n'est écrit. Avec une clé PriceLabs valide, la grille, le marché et les réservations sont lus immédiatement et la première revue est lancée.</Banner>
        <Submit icon="check" pendingLabel="Création du dossier…">Créer le dossier et calculer les planchers</Submit>
      </ActionForm>
    </Page>
  );
}

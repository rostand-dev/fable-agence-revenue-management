import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner } from "@/components/ui";
import { ActionForm, Submit } from "@/components/forms";
import { saveSeasonsAction } from "@/app/actions/seasons";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { missingEconomics } from "@/lib/engine/economics";
import { MAX_SEASONS } from "@/lib/engine/seasons";
import type { EconomicModel } from "@/lib/engine/types";

export const metadata = { title: "Saisons du plancher" };
const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");

/** Saisons du plancher stratégique (US-052) : une couverture des charges fixes par nuit propre à chaque période de l'année. */
export default async function Saisons({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p || p.isDemo) notFound();
  const model = p.economics as EconomicModel;
  const seasons = model.seasons ?? [];
  const rows = Math.min(MAX_SEASONS, seasons.length + 2);
  return (
    <Page title="Saisons du plancher" sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Saisons du plancher" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}?tab=economie`}><Icon name="back" />Retour à l'économie</Link></p>
      <div className="page-head">
        <h1>Saisons du plancher</h1>
        <p>Une saison change la couverture des charges fixes par nuit vendue, donc le plancher stratégique, pendant une période qui revient chaque année. Le seuil de dérangement (plancher absolu) ne change jamais. Hors saison, la valeur de base s'applique{model.strategyContributionPerNightCents != null ? ` (${eur(model.strategyContributionPerNightCents)} € par nuit)` : ""}.</p>
      </div>
      {missingEconomics(model).length > 0 && <Banner role="attention" title="Modèle économique incomplet">Renseignez d'abord les coûts et seuils : les saisons s'appuient sur eux. <Link href={`/logements/${p.id}/couts`}>Compléter les coûts</Link></Banner>}
      <Banner role="tech" title="Appliquées par l'auditeur et le simulateur">Pour un séjour qui traverse plusieurs saisons, le plancher le plus exigeant s'applique.</Banner>
      <ActionForm action={saveSeasonsAction} hidden={{ propertyId: p.id }} className="stack" style={{ gap: 16 }}>
        {Array.from({ length: rows }, (_, i) => {
          const s = seasons[i];
          return (
            <fieldset key={i} className="card" style={{ padding: 16, margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }} data-testid="season-row">
              <legend style={{ padding: "0 6px" }}>Saison {i + 1}</legend>
              {s && <input type="hidden" name={`id_${i}`} value={s.id} />}
              <div className="field"><label htmlFor={`se-label-${i}`}>Nom</label><input id={`se-label-${i}`} name={`label_${i}`} defaultValue={s?.label ?? ""} maxLength={40} autoComplete="off" placeholder="Haute saison" /></div>
              <div className="field"><label htmlFor={`se-from-${i}`}>Du (MM-JJ)</label><input id={`se-from-${i}`} name={`from_${i}`} defaultValue={s?.from ?? ""} maxLength={5} pattern="\d{2}-\d{2}" title="Mois et jour au format MM-JJ, par exemple 07-01" autoComplete="off" placeholder="07-01" /></div>
              <div className="field"><label htmlFor={`se-to-${i}`}>Au inclus (MM-JJ)</label><input id={`se-to-${i}`} name={`to_${i}`} defaultValue={s?.to ?? ""} maxLength={5} pattern="\d{2}-\d{2}" title="Mois et jour au format MM-JJ, par exemple 08-31" autoComplete="off" placeholder="08-31" /></div>
              <div className="field"><label htmlFor={`se-eur-${i}`}>Charges fixes par nuit (€)</label><input id={`se-eur-${i}`} name={`eur_${i}`} defaultValue={s ? eur(s.strategyContributionPerNightCents) : ""} inputMode="decimal" autoComplete="off" placeholder="45,00" /></div>
            </fieldset>
          );
        })}
        <p className="section-note" style={{ margin: 0 }}>Laissez une ligne vide pour ne pas l'utiliser ; effacez-en tous les champs pour supprimer une saison. Une période qui va de fin d'année à début d'année (par exemple 12-20 au 01-05) est acceptée. Les saisons ne peuvent pas se chevaucher et restent au moins au niveau du seuil de dérangement. Enregistrer crée une version du modèle économique et demande de valider de nouveau les planchers.</p>
        <Submit icon="check" pendingLabel="Enregistrement…">Enregistrer les saisons</Submit>
      </ActionForm>
    </Page>
  );
}

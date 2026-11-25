import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner, State } from "@/components/ui";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { showValue } from "@/lib/economics-versions";
import { listEconomicsVersions } from "@/lib/services/economics-versions";

export const metadata = { title: "Versions du modèle économique" };
const when = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });

/** Historique du modèle économique (US-022) : une version par changement, avec l'auteur et ce qui a changé. */
export default async function VersionsEconomie({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [p] = await db.select({ id: schema.properties.id, name: schema.properties.name, current: schema.properties.economicsVersion }).from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, user.tenantId)));
  if (!p) notFound();
  const versions = await listEconomicsVersions(user.tenantId, p.id);
  return (
    <Page title="Versions du modèle économique" sub={p.name} crumbs={[{ label: "Logements", href: "/logements" }, { label: p.name, href: `/logements/${p.id}` }, { label: "Versions de l'économie" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}?tab=hub-economie`}><Icon name="back" />Retour à Économie</Link></p>
      <div className="page-head">
        <h1>Versions du modèle économique</h1>
        <p>Chaque changement de commission, de coût ou de seuil crée une version. Une version n'est jamais modifiée ni effacée : on retrouve ce qui valait à une date donnée, et qui l'a changé.</p>
      </div>
      {versions.length === 0
        ? <Banner role="tech" title="Aucune version enregistrée">La première version est créée quand les coûts et seuils sont validés.</Banner>
        : <div className="stack" data-testid="economics-versions">
          {versions.map((v) => (
            <details className="fold" key={v.id} data-testid="economics-version" open={v.version === p.current}>
              <summary style={{ flexWrap: "wrap", rowGap: 6 }}>
                <span>Version {v.version}</span>
                <span className="muted">{when(v.createdAt)} · {v.author}</span>
                <span style={{ marginLeft: "auto" }}>{v.version === p.current ? <State role="sain">en vigueur</State> : <State role="neutre">ancienne</State>}</span>
              </summary>
              <div className="fold-body">
                {v.changes.length === 0 ? <p style={{ margin: 0 }}>Modèle repris tel quel lors de la mise en place du versionnage.</p> : (
                  <ul role="list" className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 10 }} aria-label={`Changements de la version ${v.version}`}>
                    {v.changes.map((c) => (
                      <li key={c.key} style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline", justifyContent: "space-between" }}>
                        <strong>{c.label}</strong>
                        <span><span className="muted">{showValue(c.from)}</span><span aria-hidden="true"> → </span><span className="sr-only"> devient </span><strong>{showValue(c.to)}</strong></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          ))}
        </div>}
    </Page>
  );
}

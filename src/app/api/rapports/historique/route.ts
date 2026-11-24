import { getUser } from "@/lib/auth";
import { historyCsv, measuresCsv } from "@/lib/reports/csv";
import { parseHistoryFilters, slug } from "@/lib/reports/filters";
import { listMeasures, listReportHistory, propertyName, recordExport, ReportError } from "@/lib/services/reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Export CSV de l'historique d'un logement (US-113) : ?logement=<id>&type=rapports|mesures, avec les mêmes filtres que l'écran
 * (?etat=CERTIFIED|DRAFT, ?annee=AAAA, ?resultat=POSITIVE|NEUTRAL|NEGATIVE|INCONCLUSIVE ; une valeur invalide est ignorée).
 * Lecture authentifiée, isolée par propriétaire d'espace, tracée au journal.
 */
export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Session expirée : reconnectez-vous." }, { status: 401, headers: NO_STORE });
  const q = new URL(req.url).searchParams;
  const propertyId = q.get("logement"), type = q.get("type");
  if (!propertyId || propertyId.length > 80) return Response.json({ error: "logement est obligatoire." }, { status: 400, headers: NO_STORE });
  if (type !== "rapports" && type !== "mesures") return Response.json({ error: "type doit valoir rapports ou mesures." }, { status: 400, headers: NO_STORE });
  const f = parseHistoryFilters(q);
  try {
    const name = await propertyName(user.tenantId, propertyId);
    const rows = type === "rapports" ? await listReportHistory(user.tenantId, propertyId, f) : await listMeasures(user.tenantId, propertyId, f);
    const body = type === "rapports" ? historyCsv(name, rows as Awaited<ReturnType<typeof listReportHistory>>) : measuresCsv(name, rows as Awaited<ReturnType<typeof listMeasures>>);
    await recordExport({ id: user.id, name: user.name, tenantId: user.tenantId, role: user.role }, "Property", propertyId, `${user.name} a exporté en CSV l'historique des ${type} de ${name} (${rows.length} ligne${rows.length > 1 ? "s" : ""}).`, { format: "csv", type, rows: rows.length, ...f });
    return new Response(body, { headers: { ...NO_STORE, "X-Content-Type-Options": "nosniff", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="historique-${type}-${slug(name)}.csv"` } });
  } catch (e) {
    if (e instanceof ReportError) return Response.json({ error: e.message }, { status: 404, headers: NO_STORE });
    console.error("[rapports/historique]", e instanceof Error ? e.message : e);
    return Response.json({ error: "Erreur technique : l'export n'a pas pu être produit." }, { status: 500, headers: NO_STORE });
  }
}

import { getUser } from "@/lib/auth";
import { reportCsv } from "@/lib/reports/csv";
import { slug } from "@/lib/reports/filters";
import { reportPdf } from "@/lib/reports/document";
import { fmtMonth } from "@/lib/dates";
import { getCertifiedReport, recordExport, ReportError } from "@/lib/services/reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Export d'un rapport mensuel CERTIFIÉ (US-113) : ?format=csv (Excel français) ou ?format=pdf. Lecture authentifiée, isolée par propriétaire d'espace
 * (l'espace vient de la session, jamais d'un paramètre), tracée au journal. Un brouillon ne s'exporte pas (409).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Session expirée : reconnectez-vous." }, { status: 401, headers: NO_STORE });
  const format = new URL(req.url).searchParams.get("format");
  if (format !== "csv" && format !== "pdf") return Response.json({ error: "format doit valoir csv ou pdf." }, { status: 400, headers: NO_STORE });
  const { id } = await ctx.params;
  try {
    const r = await getCertifiedReport(user.tenantId, id);
    const body = format === "csv" ? reportCsv(r) : new Uint8Array(reportPdf(r));
    await recordExport({ id: user.id, name: user.name, tenantId: user.tenantId, role: user.role }, "MonthlyReport", r.id, `${user.name} a exporté en ${format.toUpperCase()} le rapport de ${fmtMonth(r.month)} (${r.snapshot.property.name}), version ${r.version}.`, { format, month: r.month, version: r.version });
    const name = `rapport-${slug(r.snapshot.property.name)}-${r.month}-v${r.version}.${format}`;
    return new Response(body, { headers: { ...NO_STORE, "X-Content-Type-Options": "nosniff", "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/pdf", "Content-Disposition": `attachment; filename="${name}"` } });
  } catch (e) {
    if (e instanceof ReportError) return Response.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 409, headers: NO_STORE });
    console.error("[rapports/export]", e instanceof Error ? e.message : e);
    return Response.json({ error: "Erreur technique : l'export n'a pas pu être produit." }, { status: 500, headers: NO_STORE });
  }
}

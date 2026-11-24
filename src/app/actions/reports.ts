"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { certifyReport, draftReport, ReportError, saveReport, type ReportActor } from "@/lib/services/reports";

async function run(fn: (u: ReportActor) => Promise<unknown>, ok: string): Promise<FormState> {
  const u = await requireUser();
  try { await fn({ id: u.id, name: u.name, tenantId: u.tenantId, role: u.role }); }
  catch (e) {
    if (e instanceof ReportError) return { error: e.message };
    console.error("[rapports]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return { ok };
}
const str = (fd: FormData, k: string) => { const v = fd.get(k); return typeof v === "string" ? v : ""; };

/** Prépare (ou régénère) le brouillon du rapport d'un mois terminé ; ouvre une nouvelle version si la précédente est certifiée (US-112). */
export async function draftReportAction(_: FormState, fd: FormData): Promise<FormState> {
  return run((u) => draftReport(u, str(fd, "propertyId"), str(fd, "month"), { replaceEdits: str(fd, "replaceEdits") === "1" }), "Rapport préparé : relisez-le puis certifiez-le.");
}
/**
 * Enregistre le texte retouché d'un brouillon, ou le certifie (`intent=certify`, avec la case de relecture cochée) : un seul formulaire,
 * donc le texte certifié est exactement celui qui est affiché. Une certification fige le rapport ; plus rien ne peut s'y modifier ensuite.
 */
export async function saveReportAction(_: FormState, fd: FormData): Promise<FormState> {
  if (str(fd, "intent") === "certify") {
    if (str(fd, "confirm") !== "1") return { error: "Cochez la case de relecture pour certifier : une certification est définitive." };
    return run((u) => certifyReport(u, str(fd, "reportId"), str(fd, "narrative")), "Rapport certifié.");
  }
  return run((u) => saveReport(u, str(fd, "reportId"), str(fd, "narrative")), "Texte enregistré.");
}

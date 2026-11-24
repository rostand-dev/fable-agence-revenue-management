"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { RunbookError, setRunbookStep } from "@/lib/services/runbook";

/** Coche ou décoche une étape du guide pas-à-pas (US-102). */
export async function toggleRunbookStepAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  try { await setRunbookStep({ id: u.id, name: u.name, tenantId: u.tenantId, role: u.role }, String(fd.get("actionId") ?? ""), String(fd.get("stepId") ?? ""), fd.get("done") === "1"); }
  catch (e) {
    if (e instanceof RunbookError) return { error: e.message };
    console.error("[runbook]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return null;
}

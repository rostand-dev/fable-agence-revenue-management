"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import type { FormState } from "@/components/forms";
import * as D from "@/lib/services/decisions";
import { runDailyReview } from "@/lib/services/review";
import { seedDemo } from "@/lib/services/seed";
import { askAgent } from "@/lib/services/chat";

async function run(fn: (actor: { id: string; name: string; tenantId: string }) => Promise<unknown>, ok?: string): Promise<FormState> {
  const u = await requireUser();
  try { await fn({ id: u.id, name: u.name, tenantId: u.tenantId }); }
  catch (e) { if (e instanceof D.DecisionError) return { error: e.message }; console.error(e); return { error: "Une erreur technique est survenue. Rien n'a été modifié." }; }
  revalidatePath("/", "layout");
  return ok ? { ok } : null;
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function approveAction(_: FormState, fd: FormData) { return run((a) => D.approve(a, s(fd, "opportunityId"), Number(s(fd, "candidate")), s(fd, "comment"))); }
export async function rejectAction(_: FormState, fd: FormData) { return run((a) => D.reject(a, s(fd, "opportunityId"), s(fd, "comment"))); }
export async function deferAction(_: FormState, fd: FormData) { return run((a) => D.defer(a, s(fd, "opportunityId"), 3)); }
export async function reopenAction(_: FormState, fd: FormData) { return run((a) => D.reopen(a, s(fd, "opportunityId"))); }
export async function executeAction(_: FormState, fd: FormData) { return run((a) => D.execute(a, s(fd, "actionId"), fd.has("scope") ? { scope: s(fd, "scope"), date: s(fd, "date"), proof: s(fd, "proof") } : undefined)); }
export async function verifyAction(_: FormState, fd: FormData) { return run((a) => D.verify(a, s(fd, "actionId"))); }
export async function rollbackAction(_: FormState, fd: FormData) { return run((a) => D.rollback(a, s(fd, "actionId"), s(fd, "reason"))); }
export async function reviewAction(_: FormState, __: FormData) {
  return run(async (a) => { const r = await runDailyReview(a.tenantId, "MANUAL"); return r; }, "Revue terminée.");
}
export async function resetDemoAction(_: FormState, __: FormData) { return run((a) => seedDemo(a.tenantId), "Démonstration réinstallée à la date du jour."); }
export async function chatAction(_: FormState, fd: FormData) {
  const q = s(fd, "question").trim();
  if (q.length < 2) return { error: "Écrivez une question." };
  return run((a) => askAgent(a.tenantId, s(fd, "agentId"), s(fd, "opportunityId") || null, q.slice(0, 600)));
}

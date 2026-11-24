import { and, eq, inArray } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { CHANNELS } from "@/lib/engine/types";
import { buildRunbook, runbookProgress, type RunbookProgress, type RunbookStep } from "@/lib/promotions/runbook";
import { can, denyMessage, executePermission, PERMISSION_LABEL, ROLE_LABEL, type Role } from "@/lib/rbac";

/**
 * Guide pas-à-pas d'une action manuelle (US-102) : étapes construites par `promotions/runbook.ts`, avancement enregistré ici.
 * Cocher une étape est un geste d'exécution : même droit que « Déclarer la réalisation » ; il n'a d'effet que sur une action approuvée.
 */
const { revenueActions, runbookSteps } = schema;
export type RunbookActor = { id: string; name: string; tenantId: string; role: Role };
export class RunbookError extends Error { constructor(public code: "NOT_FOUND" | "INVALID" | "FORBIDDEN" | "CONFLICT", message: string) { super(message); this.name = "RunbookError"; } }

type ActionRow = typeof revenueActions.$inferSelect;
/** Étapes du guide d'une action, d'après ce qu'elle porte (type, canal, paramètres, prix simulé). */
export function stepsOfAction(a: Pick<ActionRow, "type" | "label" | "target" | "parameters" | "simulation">): RunbookStep[] {
  const system = a.target?.system, channel = (CHANNELS as string[]).includes(system) ? system : a.target?.channel ?? a.parameters?.channel ?? null;
  return buildRunbook({ type: a.type, channel, label: a.label, parameters: a.parameters ?? {}, soldNightlyCents: a.simulation?.proposed?.soldNightlyCents ?? null });
}

export type RunbookState = { steps: (RunbookStep & { done: { by: string; at: Date } | null })[]; progress: RunbookProgress };
const { users } = schema;

export async function getRunbook(tenantId: string, actionId: string): Promise<RunbookState> {
  const [a] = await db.select().from(revenueActions).where(and(eq(revenueActions.id, actionId), eq(revenueActions.tenantId, tenantId)));
  if (!a) throw new RunbookError("NOT_FOUND", "Action introuvable.");
  const rows = await db.select().from(runbookSteps).where(and(eq(runbookSteps.actionId, actionId), eq(runbookSteps.tenantId, tenantId)));
  const by = new Map(rows.map((r) => [r.stepId, r]));
  const names = new Map((rows.length ? await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, rows.map((r) => r.doneBy)))) : []).map((u) => [u.id, u.name]));
  const steps = stepsOfAction(a).map((s) => ({ ...s, done: by.has(s.id) ? { by: names.get(by.get(s.id)!.doneBy) ?? "Un membre de l'équipe", at: by.get(s.id)!.doneAt } : null }));
  return { steps, progress: runbookProgress(steps, steps.filter((s) => s.done).map((s) => s.id)) };
}

/** Coche ou décoche une étape. Rejoué sans effet (cocher deux fois = une ligne) ; chaque changement réel est inscrit au journal d'audit. */
export async function setRunbookStep(actor: RunbookActor, actionId: string, stepId: string, done: boolean): Promise<RunbookState> {
  const [a] = await db.select().from(revenueActions).where(and(eq(revenueActions.id, actionId), eq(revenueActions.tenantId, actor.tenantId)));
  if (!a) throw new RunbookError("NOT_FOUND", "Action introuvable.");
  const permission = executePermission(a.simulation?.executionMode);
  if (!can(actor.role, permission)) {
    try { await recordAudit(db, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "access.denied", entity: "RevenueAction", entityId: a.id, summary: `${actor.name} (${ROLE_LABEL[actor.role]}) : tentative refusée — ${PERMISSION_LABEL[permission]}.`, payload: { permission, role: actor.role } }); } catch (e) { console.error("[rbac] refus non consigné", (e as Error).message); }
    throw new RunbookError("FORBIDDEN", denyMessage(actor.role, permission));
  }
  const step = stepsOfAction(a).find((s) => s.id === stepId);
  if (!step || !step.checkable) throw new RunbookError("INVALID", "Cette étape n'existe pas dans le guide de l'action.");
  await db.transaction(async (tx) => {
    // Verrou partagé sur l'action le temps du geste : « Déclarer la réalisation » (qui la fait passer à EXECUTING) attend la fin de celui-ci,
    // et un geste qui arrive après elle voit le nouvel état. Aucune étape ne se coche sur une action déjà partie.
    const [cur] = await tx.select({ status: revenueActions.status }).from(revenueActions).where(and(eq(revenueActions.id, actionId), eq(revenueActions.tenantId, actor.tenantId))).for("share");
    if (!cur || cur.status !== "APPROVED") throw new RunbookError("CONFLICT", "Le guide ne se coche que tant que l'action est approuvée et pas encore déclarée.");
    let changed = false;
    if (done) {
      const r = await tx.insert(runbookSteps).values({ id: newId("rbs"), tenantId: actor.tenantId, actionId, stepId, doneBy: actor.id }).onConflictDoNothing().returning({ id: runbookSteps.id });
      changed = r.length > 0;
    } else {
      const r = await tx.delete(runbookSteps).where(and(eq(runbookSteps.actionId, actionId), eq(runbookSteps.stepId, stepId), eq(runbookSteps.tenantId, actor.tenantId))).returning({ id: runbookSteps.id });
      changed = r.length > 0;
    }
    if (changed) await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: done ? "runbook.step_checked" : "runbook.step_unchecked", entity: "RevenueAction", entityId: a.id, summary: `${actor.name} ${done ? "a coché" : "a décoché"} l'étape « ${step.title} » du guide de « ${a.label} ».`, payload: { stepId, done } });
  });
  return getRunbook(actor.tenantId, actionId);
}

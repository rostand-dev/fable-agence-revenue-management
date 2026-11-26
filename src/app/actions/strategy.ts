"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { PortfolioError } from "@/lib/services/portfolio";
import { discardDraft, publishDraft, rollbackToVersion, saveDraft } from "@/lib/services/strategy";

/** Strategy Builder (US-023) : brouillon, publication, restauration. Règles et audit : lib/services/strategy.ts. */
const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "");
async function run(fn: () => Promise<unknown>, ok: string): Promise<FormState> {
  try { await fn(); } catch (e) {
    if (e instanceof PortfolioError) return { error: e.message };
    console.error("[strategie]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return { ok };
}
export async function saveStrategyDraftAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(() => saveDraft(u, txt(fd, "propertyId"), { objective: txt(fd, "objective"), positioning: txt(fd, "positioning"), minStay: txt(fd, "minStay"), maxDiscountStackPct: txt(fd, "maxDiscountStackPct"), maxPriceChangePct: txt(fd, "maxPriceChangePct") }, Number.isInteger(Number(txt(fd, "baseVersion"))) && txt(fd, "baseVersion") !== "" ? Number(txt(fd, "baseVersion")) : null), "Brouillon enregistré. Rien n'est changé tant que vous ne publiez pas.");
}
export async function discardStrategyDraftAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(() => discardDraft(u, txt(fd, "propertyId")), "Brouillon abandonné.");
}
export async function publishStrategyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(() => publishDraft(u, txt(fd, "propertyId"), txt(fd, "note")), "Stratégie publiée.");
}
export async function rollbackStrategyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(() => rollbackToVersion(u, txt(fd, "propertyId"), txt(fd, "version"), txt(fd, "note")), "Réglages restaurés dans une nouvelle version.");
}

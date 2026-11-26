"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { PortfolioError } from "@/lib/services/portfolio";
import { recordReconciliation, validateFloors } from "@/lib/services/validations";

const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "");
async function run(fn: () => Promise<void>, ok: string): Promise<FormState> {
  try { await fn(); } catch (e) {
    if (e instanceof PortfolioError) return { error: e.message };
    console.error("[validations]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return { ok };
}

/** Validation des planchers (grille canal × 2/7/28 nuits) par une personne. Règles et audit : lib/services/validations.ts. */
export async function validateFloorsAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(() => validateFloors(u, txt(fd, "propertyId"), txt(fd, "fingerprint"), txt(fd, "note")), "Planchers validés.");
}

/** Attestation du rapprochement d'un échantillon de réservations. */
export async function recordReconciliationAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(() => recordReconciliation(u, txt(fd, "propertyId"), { sampleSize: txt(fd, "sampleSize"), maxGapPct: txt(fd, "maxGapPct"), source: txt(fd, "source"), note: txt(fd, "note") }), "Rapprochement enregistré.");
}

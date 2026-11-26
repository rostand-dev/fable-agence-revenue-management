"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { PortfolioError } from "@/lib/services/portfolio";
import { activateProperty } from "@/lib/services/quality";

/** Activation d'un logement (Observation → Actif), bloquée par la checklist de qualité (US-024). Règles et audit : lib/services/quality.ts. */
export async function activatePropertyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  try { await activateProperty(u, String(fd.get("propertyId") ?? "")); }
  catch (e) {
    if (e instanceof PortfolioError) return { error: e.message };
    console.error("[qualite]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return { ok: "Logement activé." };
}

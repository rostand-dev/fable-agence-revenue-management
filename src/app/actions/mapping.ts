"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { confirmMapping } from "@/lib/services/mapping";
import { PortfolioError } from "@/lib/services/portfolio";

/** Confirmation du mapping des identifiants externes (US-021). Règles et audit : lib/services/mapping.ts. */
export async function confirmMappingAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  try { await confirmMapping(u, String(fd.get("propertyId") ?? ""), fd.get("acknowledge") === "on", fd.get("fingerprint")); }
  catch (e) {
    if (e instanceof PortfolioError) return { error: e.message };
    console.error("[mapping]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return { ok: "Mapping confirmé." };
}

"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { declarePromotion, endPromotion, PromotionError, updatePromotion, verifyPromotion, type PromotionActor } from "@/lib/services/promotion-registry";

/** Lit tous les champs du formulaire dans un objet simple : la validation (modules purs) décide de ce qui est acceptable. */
const fields = (fd: FormData) => {
  const f = Object.fromEntries(Array.from(fd.entries()).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  // le formulaire d'ajout propose un seul choix « canal · type » (valeur `CANAL:TYPE`) : on le sépare ici, la validation vérifie que le couple existe
  if (f.typeKey) { const [channel, kind] = f.typeKey.split(":"); f.channel = channel ?? ""; f.kind = kind ?? ""; }
  return f;
};

async function run(fn: (u: PromotionActor) => Promise<unknown>, ok: string): Promise<FormState> {
  const u = await requireUser();
  try { await fn({ id: u.id, name: u.name, tenantId: u.tenantId, role: u.role }); }
  catch (e) {
    if (e instanceof PromotionError) return { error: e.message };
    console.error("[promotions]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  return { ok };
}

/** Déclare une promotion relevée dans l'extranet (US-100). */
export async function declarePromotionAction(_: FormState, fd: FormData): Promise<FormState> {
  const f = fields(fd);
  return run((u) => declarePromotion(u, f.propertyId ?? "", f), "Promotion ajoutée au registre.");
}
export async function updatePromotionAction(_: FormState, fd: FormData): Promise<FormState> {
  const f = fields(fd);
  return run((u) => updatePromotion(u, f.promotionId ?? "", f), "Promotion modifiée : relisez-la dans l'extranet pour la marquer vérifiée.");
}
export async function endPromotionAction(_: FormState, fd: FormData): Promise<FormState> {
  const f = fields(fd);
  return run((u) => endPromotion(u, f.promotionId ?? "", f.reason), "Promotion terminée.");
}
export async function verifyPromotionAction(_: FormState, fd: FormData): Promise<FormState> {
  const f = fields(fd);
  return run((u) => verifyPromotion(u, f.promotionId ?? ""), "Promotion marquée comme vérifiée.");
}

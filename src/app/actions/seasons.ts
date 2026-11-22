"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { MAX_SEASONS } from "@/lib/engine/seasons";
import { PortfolioError } from "@/lib/services/portfolio";
import { saveSeasons } from "@/lib/services/seasons";

const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** « 12,50 » ou « 12.5 » → centimes ; NaN si la saisie n'est pas un montant simple (jamais de zéro par défaut). */
const toMinorUnits = (s: string) => (/^\d+([.,]\d{1,2})?$/.test(s) ? Math.round(Number(s.replace(",", ".")) * 100) : NaN);

/** Enregistre les saisons du plancher d'un logement (lignes `label_i`, `from_i`, `to_i`, `eur_i`). Une ligne entièrement vide est ignorée. Règles : lib/engine/seasons.ts. */
export async function saveSeasonsAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < MAX_SEASONS; i++) {
    const label = txt(fd, `label_${i}`), from = txt(fd, `from_${i}`), to = txt(fd, `to_${i}`), eur = txt(fd, `eur_${i}`), id = txt(fd, `id_${i}`);
    if (!label && !from && !to && !eur) continue;
    rows.push({ id: id || undefined, label, from, to, strategyContributionPerNightCents: toMinorUnits(eur) });
  }
  try {
    const r = await saveSeasons(u, txt(fd, "propertyId"), rows);
    revalidatePath("/", "layout");
    return { ok: r.version ? `Saisons enregistrées (version ${r.version} du modèle économique). Les planchers sont à valider de nouveau.` : "Aucun changement." };
  } catch (e) {
    if (e instanceof PortfolioError) return { error: e.message };
    console.error("[saisons]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
}

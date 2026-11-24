import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayISO } from "@/lib/dates";
import { CHANNELS, type Channel, type EconomicModel, type Strategy } from "@/lib/engine/types";
import { compilePromotions, parseCompileInput, type ActiveRow, type CompileInput, type CompileResult } from "@/lib/promotions/compiler";
import { COOLDOWN_DAYS } from "@/lib/promotions/lifecycle";
import { VERIFY_MAX_AGE_DAYS } from "@/lib/promotions/registry";
import { PromotionError } from "./promotion-registry";

const { promotions, properties } = schema;

export type CompiledView =
  | { ok: false; error: string }
  | { ok: true; input: CompileInput; result: CompileResult };

/**
 * Compile une intention commerciale pour un logement (US-101). Lecture seule : rien n'est enregistré ni envoyé à un canal.
 * Lit le registre (US-100) pour les promotions déjà en place, le modèle économique et la stratégie du logement ; isolé par propriétaire d'espace.
 * Une saisie invalide renvoie une erreur lisible plutôt que de lever : l'écran la montre au-dessus du formulaire.
 */
export async function compileForProperty(tenantId: string, propertyId: string, raw: Record<string, unknown>, now: Date = new Date()): Promise<CompiledView> {
  const [p] = await db.select({ id: properties.id, economics: properties.economics, strategy: properties.strategy }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PromotionError("NOT_FOUND", "Logement introuvable.");
  const today = todayISO(now);
  const parsed = parseCompileInput(raw, today);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const rows = await db.select().from(promotions).where(and(eq(promotions.tenantId, tenantId), eq(promotions.propertyId, propertyId), ne(promotions.status, "ENDED")));
  const live = rows.filter((r) => !(r.stayTo && r.stayTo <= today));
  const active: ActiveRow[] = live.map((r) => ({ channel: r.channel, kind: r.kind, label: r.label, discountPct: r.discountPct, stayFrom: r.stayFrom, stayTo: r.stayTo }));
  // même règle que le simulateur et la détection : une promotion jamais relue, ou relue il y a plus de 7 jours, rend le registre du canal incertain
  const registryStale: Partial<Record<Channel, boolean>> = {};
  const registryEmpty: Partial<Record<Channel, boolean>> = {};
  for (const c of CHANNELS) {
    registryStale[c] = live.some((r) => r.channel === c && (r.status === "ACTIVE" || r.status === "PLANNED") && (!r.verifiedAt || +now - +r.verifiedAt > VERIFY_MAX_AGE_DAYS * 86_400_000));
    registryEmpty[c] = !live.some((r) => r.channel === c);
  }
  // US-104 : fins manuelles récentes du logement (la période de repos dure 7 jours)
  const endedRows = (await db.select().from(promotions).where(and(eq(promotions.tenantId, tenantId), eq(promotions.propertyId, propertyId), eq(promotions.status, "ENDED")))).filter((r) => r.endedAt && +now - +r.endedAt < (COOLDOWN_DAYS + 1) * 86_400_000);
  const max = (p.strategy as Strategy | null)?.maxDiscountStackPct;
  const result = compilePromotions(parsed.value, { model: p.economics as EconomicModel, maxDiscountStackPct: typeof max === "number" && Number.isFinite(max) ? max : null, active, registryStale, registryEmpty, ended: endedRows, today });
  return { ok: true, input: parsed.value, result };
}

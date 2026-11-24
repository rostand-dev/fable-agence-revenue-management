import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { todayISO } from "@/lib/dates";
import { EXPIRY_REASON } from "@/lib/promotions/lifecycle";

const { promotions } = schema;
const fr = (d: string) => d.split("-").reverse().join("/");

/**
 * Balayage d'expiration (US-104) : toute promotion active ou planifiée dont les séjours sont passés est terminée avec le motif « Expirée : séjours terminés ».
 * Appelé par le planificateur (toutes les 15 min) ; rejouable sans effet (une promotion déjà terminée n'est plus visée). Un événement d'audit par promotion, acteur système.
 * Une promotion permanente (sans dates de séjour) n'expire jamais.
 */
export async function expirePromotions(now: Date = new Date()): Promise<number> {
  const today = todayISO(now);
  const due = await db.select({ id: promotions.id, tenantId: promotions.tenantId, propertyId: promotions.propertyId, label: promotions.label, channel: promotions.channel, stayTo: promotions.stayTo })
    .from(promotions).where(and(inArray(promotions.status, ["ACTIVE", "PLANNED"]), lte(promotions.stayTo, today), sql`${promotions.stayTo} is not null`));
  let n = 0;
  for (const p of due) {
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx.update(promotions).set({ status: "ENDED", endedAt: now, endReason: EXPIRY_REASON, updatedAt: now })
          .where(and(eq(promotions.id, p.id), eq(promotions.tenantId, p.tenantId), inArray(promotions.status, ["ACTIVE", "PLANNED"]))).returning({ id: promotions.id });
        if (!row) return; // terminée entre-temps par quelqu'un : rien à consigner
        await recordAudit(tx, { tenantId: p.tenantId, actor: "system", type: "promotion.expired", entity: "Property", entityId: p.propertyId,
          summary: `« ${p.label} » (${p.channel === "BOOKING" ? "Booking.com" : "Airbnb"}) expire : ses séjours se terminaient le ${fr(p.stayTo!)}.`, payload: { promotionId: p.id, stayTo: p.stayTo } });
        n++;
      });
    } catch (e) { console.error("[expiration]", p.id, e instanceof Error ? e.message : e); }
  }
  return n;
}

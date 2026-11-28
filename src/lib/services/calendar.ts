import { and, eq, gte, lte, min } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayISO, type ISODate } from "../dates";

const { calendarDays } = schema;

/** Date de lecture (Paris) des nuits du `from` au `to` inclus : la plus ancienne, pour ne jamais paraître plus à jour qu'on ne l'est. null : aucune nuit lue. */
export async function calendarReadOn(tenantId: string, propertyId: string, from: ISODate, to: ISODate): Promise<ISODate | null> {
  const [r] = await db.select({ at: min(calendarDays.observedAt) }).from(calendarDays)
    .where(and(eq(calendarDays.tenantId, tenantId), eq(calendarDays.propertyId, propertyId), gte(calendarDays.date, from), lte(calendarDays.date, to)));
  return r?.at ? todayISO(new Date(r.at)) : null;
}

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";

const HOUR = 60 * 60_000;

/**
 * Limitation de débit en base : enregistre la tentative et dit si elle est autorisée.
 * Toute tentative compte, même refusée, pour qu'un acharnement ne se « débloque » pas de lui-même.
 */
export async function allowAttempt(kind: string, keyHash: string, limit: number, windowMs = HOUR): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.authAttempts)
    .where(and(eq(schema.authAttempts.kind, kind), eq(schema.authAttempts.keyHash, keyHash), gte(schema.authAttempts.createdAt, since)));
  await db.insert(schema.authAttempts).values({ id: newId("att"), kind, keyHash });
  return (row?.n ?? 0) < limit;
}

/** Ménage : les tentatives de plus de 24 h ne servent plus. */
export async function purgeOldAttempts(): Promise<void> {
  await db.delete(schema.authAttempts).where(lt(schema.authAttempts.createdAt, new Date(Date.now() - 24 * HOUR)));
}

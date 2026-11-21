import { and, desc, eq, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { diffEconomics, versionModel } from "@/lib/economics-versions";
import type { EconomicModel } from "@/lib/engine/types";

const { economicModelVersions: versions, properties, users } = schema;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Enregistre une nouvelle version du modèle économique si, et seulement si, quelque chose a changé.
 * Le numéro est pris par un incrément atomique sur le logement : deux enregistrements simultanés n'obtiennent jamais le même.
 * À appeler dans la transaction qui écrit le modèle. Renvoie le numéro créé, ou null s'il n'y avait rien à versionner.
 */
export async function recordEconomicsVersion(tx: Tx, o: { tenantId: string; propertyId: string; previous: EconomicModel | null; next: EconomicModel; createdBy: string }): Promise<number | null> {
  const changes = diffEconomics(o.previous, o.next);
  if (!changes.length) return null;
  const [row] = await tx.update(properties).set({ economicsVersion: sql`${properties.economicsVersion} + 1` }).where(and(eq(properties.id, o.propertyId), eq(properties.tenantId, o.tenantId))).returning({ v: properties.economicsVersion });
  if (!row) return null;
  await tx.insert(versions).values({ id: newId("ecv"), tenantId: o.tenantId, propertyId: o.propertyId, version: row.v, model: versionModel(o.next), changes, createdBy: o.createdBy });
  return row.v;
}

/** Historique d'un logement de l'espace, de la plus récente à la plus ancienne, avec le nom de l'auteur. */
export async function listEconomicsVersions(tenantId: string, propertyId: string) {
  const rows = await db.select({ id: versions.id, version: versions.version, changes: versions.changes, createdBy: versions.createdBy, createdAt: versions.createdAt, authorName: users.name })
    .from(versions).leftJoin(users, and(eq(users.id, versions.createdBy), eq(users.tenantId, tenantId)))
    .where(and(eq(versions.tenantId, tenantId), eq(versions.propertyId, propertyId))).orderBy(desc(versions.version));
  return rows.map((r) => ({ ...r, author: r.createdBy === "system" ? "Reprise automatique" : r.authorName ?? "Utilisateur supprimé" }));
}

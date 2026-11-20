import { db, newId, schema } from "@/db";
import { AUDIT_TYPES, isAuditType, redactPayload, type AuditType } from "./types";

/** `db` ou une transaction : l'événement d'audit s'écrit dans la même transaction que la modification qu'il consigne. */
export type AuditExecutor = Pick<typeof db, "insert">;

export type AuditEvent = {
  tenantId: string;
  /** `user:<id>`, `agent:<id>`, `system` ou `demo` */
  actor: string;
  type: AuditType;
  entity: string;
  entityId: string;
  /** Phrase lisible, en français, qui dit qui a fait quoi */
  summary: string;
  /** Détail structuré (avant/après, commentaire, verdict). Les secrets sont masqués automatiquement. */
  payload?: unknown;
  /** Réservé à l'historique de démonstration, qui rejoue un passé */
  at?: Date;
};

/**
 * Seule porte d'entrée du journal d'audit (US-012). Passer `tx` pour qu'une approbation, une exécution ou un réglage
 * et son événement réussissent ou échouent ensemble. Le journal est en ajout seul : la base refuse toute modification.
 */
export async function recordAudit(ex: AuditExecutor, e: AuditEvent): Promise<string> {
  if (!isAuditType(e.type)) {
    // une faute de frappe ne doit pas faire perdre l'événement en production ; en test elle fait échouer
    const msg = `[audit] type d'événement inconnu : ${String(e.type)} (à ajouter à src/lib/audit/types.ts)`;
    if (process.env.VITEST) throw new Error(msg);
    console.error(msg);
  }
  const id = newId("evt");
  await ex.insert(schema.auditEvents).values({
    id, tenantId: e.tenantId, actor: e.actor, type: e.type, entity: e.entity, entityId: e.entityId, summary: e.summary.length > 1500 ? e.summary.slice(0, 1499) + "…" : e.summary,
    payload: e.payload === undefined ? undefined : redactPayload(e.payload),
    ...(e.at ? { createdAt: e.at } : {}),
  });
  return id;
}

export const KNOWN_AUDIT_TYPES = Object.keys(AUDIT_TYPES) as AuditType[];

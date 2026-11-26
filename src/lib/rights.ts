import { db } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { can, denyMessage, PERMISSION_LABEL, ROLE_LABEL, type Permission, type Role } from "@/lib/rbac";

export type RightsActor = { id: string; name: string; tenantId: string; role: Role };
export type RightsTarget = { entity: string; id: string };

/**
 * Garde des écritures (écran et API) : `null` si le rôle a le droit ; sinon le message de refus, après inscription de la
 * tentative au journal d'audit (jamais le contenu de la demande). À appeler avant toute lecture de la saisie.
 */
export async function refusal(actor: RightsActor, permission: Permission, target?: RightsTarget): Promise<string | null> {
  if (can(actor.role, permission)) return null;
  const entity = target?.id ? target.entity : "Tenant", entityId = (target?.id || actor.tenantId).slice(0, 64);
  try {
    await recordAudit(db, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "access.denied", entity, entityId, summary: `${actor.name} (${ROLE_LABEL[actor.role]}) : tentative refusée — ${PERMISSION_LABEL[permission]}.`, payload: { permission, role: actor.role } });
  } catch (e) { console.error("[rbac] refus non consigné", (e as Error).message); }
  return denyMessage(actor.role, permission);
}

/** Même garde pour un formulaire : l'état à renvoyer tel quel, ou `null`. `propertyId` : le logement visé, pour le journal. */
export async function refused(actor: RightsActor, permission: Permission, propertyId?: FormDataEntryValue | null): Promise<{ error: string } | null> {
  const error = await refusal(actor, permission, typeof propertyId === "string" && propertyId ? { entity: "Property", id: propertyId } : undefined);
  return error ? { error } : null;
}

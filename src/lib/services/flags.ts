import { and, eq, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "../audit/log";
import { userActor } from "../audit/types";
import { FLAG_PROVIDERS, flagDef, isFlagScope, resolveFlag, TENANT_SCOPE_ID, type FlagContext, type FlagId, type FlagResolution, type FlagRow, type FlagScope } from "../flags/catalog";
import { PROVIDER_INFO } from "../integrations/capabilities";

export class FlagError extends Error {}
type Actor = { id: string; name: string; tenantId: string };

export async function loadFlags(tenantId: string): Promise<FlagRow[]> {
  const rows = await db.select().from(schema.featureFlags).where(eq(schema.featureFlags.tenantId, tenantId));
  return rows.map((r) => ({ flag: r.flag, scope: r.scope as FlagScope, scopeId: r.scopeId, enabled: r.enabled }));
}
/** Résolution d'un drapeau pour un contexte, en une lecture. */
export async function flagFor(tenantId: string, flag: FlagId, ctx: FlagContext = {}): Promise<FlagResolution> {
  return resolveFlag(flag, await loadFlags(tenantId), ctx);
}

/**
 * Active ou désactive un drapeau à un niveau. L'action serveur contrôle le droit `property.manage` avant l'appel ;
 * le logement doit lui appartenir, et le changement s'inscrit au journal dans la même transaction. Rejouable : sans changement, rien n'est écrit.
 */
export async function setFlag(actor: Actor, input: { flag: string; scope: string; scopeId: string; enabled: boolean }): Promise<"changed" | "unchanged"> {
  const def = flagDef(input.flag);
  if (!def) throw new FlagError("Fonction inconnue.");
  if (!isFlagScope(input.scope) || !def.scopes.includes(input.scope)) throw new FlagError("Cette fonction ne se règle pas à ce niveau.");
  let where = "pour tout votre espace", scopeId = TENANT_SCOPE_ID;
  if (input.scope === "PROPERTY") {
    const [p] = await db.select({ id: schema.properties.id, name: schema.properties.name }).from(schema.properties).where(and(eq(schema.properties.id, input.scopeId), eq(schema.properties.tenantId, actor.tenantId)));
    if (!p) throw new FlagError("Logement introuvable.");
    scopeId = p.id; where = `sur le logement ${p.name}`;
  } else if (input.scope === "INTEGRATION") {
    const prov = FLAG_PROVIDERS.find((x) => x === input.scopeId);
    if (!prov) throw new FlagError("Intégration inconnue.");
    scopeId = prov; where = `sur l'intégration ${PROVIDER_INFO[prov].name}`;
  }
  return db.transaction(async (tx) => {
    // verrou le temps de la transaction (la ligne peut ne pas exister encore) : deux demandes simultanées ne produisent pas deux événements
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`flag:${actor.tenantId}:${def.id}:${input.scope}:${scopeId}`}))`);
    const key = and(eq(schema.featureFlags.tenantId, actor.tenantId), eq(schema.featureFlags.flag, def.id), eq(schema.featureFlags.scope, input.scope), eq(schema.featureFlags.scopeId, scopeId));
    const [cur] = await tx.select().from(schema.featureFlags).where(key);
    if ((cur?.enabled ?? true) === input.enabled) return "unchanged" as const;
    await tx.insert(schema.featureFlags).values({ id: newId("flg"), tenantId: actor.tenantId, flag: def.id, scope: input.scope, scopeId, enabled: input.enabled, updatedBy: userActor(actor.id) })
      .onConflictDoUpdate({ target: [schema.featureFlags.tenantId, schema.featureFlags.flag, schema.featureFlags.scope, schema.featureFlags.scopeId], set: { enabled: input.enabled, updatedBy: userActor(actor.id), updatedAt: new Date() } });
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "flag.changed", entity: "FeatureFlag", entityId: `${def.id}:${input.scope}:${scopeId || "tenant"}`,
      summary: `${actor.name} ${input.enabled ? "réactive" : "désactive"} « ${def.label} » ${where}.`, payload: { flag: def.id, scope: input.scope, scopeId, enabled: input.enabled, previous: cur?.enabled ?? true } });
    return "changed" as const;
  });
}

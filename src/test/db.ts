import { db, newId, schema } from "@/db";

/** Un propriétaire de test (espace + utilisateur), avec un identifiant unique : les tests ne se marchent pas dessus. */
export async function makeTenant(label = "t") {
  const tenantId = newId("tn"), userId = newId("usr");
  await db.insert(schema.tenants).values({ id: tenantId, name: `Espace ${label}` });
  await db.insert(schema.users).values({ id: userId, tenantId, email: `${userId}@test.local`, name: `Utilisateur ${label}`, passwordHash: "scrypt$x$y" });
  return { tenantId, userId, actor: { id: userId, name: `Utilisateur ${label}`, tenantId } };
}

export async function makeProperty(tenantId: string, name = "Logement test") {
  const id = newId("prop");
  await db.insert(schema.properties).values({ id, tenantId, name, city: "Paris", kind: "T2", status: "ACTIVE" });
  return id;
}

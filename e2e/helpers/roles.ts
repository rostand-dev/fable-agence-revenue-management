import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

/**
 * Comptes de test à un rôle donné, dans l'espace du compte de démo (US-084).
 * Ils exigent un accès direct à la base de l'application testée (DATABASE_URL) : absent (Preview distante), les tests de rôles sont ignorés.
 * Même format de mot de passe que l'application (`scrypt$sel$hash`).
 */
export const hasDatabase = (): boolean => !!process.env.DATABASE_URL?.trim() && !!process.env.E2E_EMAIL?.trim();
const PASSWORD = "e2e-roles-passw0rd";

export async function createRoleUser(role: string, tag: string): Promise<{ email: string; password: string; id: string }> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ tenant_id: string }>("select tenant_id from users where email = $1", [process.env.E2E_EMAIL]);
    if (!rows[0]) throw new Error("compte de démo introuvable : les tests de rôles s'appuient sur son espace");
    const salt = randomBytes(16);
    const hash = `scrypt$${salt.toString("hex")}$${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
    const email = `e2e-${role.toLowerCase()}-${tag}@example.test`, id = `usr_e2e_${role.toLowerCase()}_${tag}`.slice(0, 60);
    await client.query("delete from users where email = $1", [email]);
    await client.query("insert into users (id, tenant_id, email, name, password_hash, role) values ($1, $2, $3, $4, $5, $6)", [id, rows[0].tenant_id, email, `Test ${role}`, hash, role]);
    return { email, password: PASSWORD, id };
  } finally { await client.end(); }
}
export async function deleteUser(id: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await client.query("delete from users where id = $1", [id]); } finally { await client.end(); }
}

/** Inscrit un événement `property.updated` au journal du logement (le journal est en ajout seul : il ne s'efface pas). US-081. */
export async function seedPropertyEvent(propertyId: string, summary: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ tenant_id: string }>("select tenant_id from properties where id = $1", [propertyId]);
    if (!rows[0]) throw new Error("logement introuvable");
    await client.query("insert into audit_events (id, tenant_id, actor, type, entity, entity_id, summary) values ($1, $2, 'system', 'property.updated', 'Property', $3, $4)", [`evt_e2e_${randomBytes(6).toString("hex")}`, rows[0].tenant_id, propertyId, summary]);
  } finally { await client.end(); }
}

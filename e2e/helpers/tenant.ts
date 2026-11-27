import { randomBytes, scryptSync } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import pg from "pg";

/** Requête directe sur la base de l'application testée (DATABASE_URL). */
export async function sql(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { return await c.query(text, params); } finally { await c.end(); }
}

const PASSWORD = "e2e-poche-passw0rd";

/** Un espace propre au test, avec son propriétaire connecté dans `page` (partir d'un contexte sans session). `drop` le retire. */
export async function loginNewTenant(page: Page, info: TestInfo, name: string): Promise<{ tenant: string; drop: () => Promise<void> }> {
  const tag = `${info.project.name}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const tenant = `tn_e2e_poche_${tag}`, email = `e2e-poche-${tag}@example.test`;
  const salt = randomBytes(16);
  await sql("insert into tenants (id, name) values ($1, $2)", [tenant, name]);
  await sql("insert into users (id, tenant_id, email, name, password_hash, role) values ($1, $2, $3, $4, $5, 'OWNER')", [`usr_e2e_poche_${tag}`, tenant, email, "Test poche", `scrypt$${salt.toString("hex")}$${scryptSync(PASSWORD, salt, 64).toString("hex")}`]);
  const drop = async () => {
    await sql("delete from properties where tenant_id = $1", [tenant]);
    await sql("delete from integrations where tenant_id = $1", [tenant]);
    await sql("delete from tenants where id = $1", [tenant]);
  };
  try {
    await page.goto("/connexion");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe").fill(PASSWORD);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/connexion"), { timeout: 15_000 });
  } catch (e) {
    await drop(); // connexion en échec : l'appelant ne recevra jamais `drop`
    throw e;
  }
  return { tenant, drop };
}

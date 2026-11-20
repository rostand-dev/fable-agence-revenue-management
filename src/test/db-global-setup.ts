import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/** Vide la base de test puis rejoue toutes les migrations. Refuse de toucher une base dont le nom ne contient pas « test ». */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL manquant : indiquez une base PostgreSQL dédiée aux tests (son nom doit contenir « test »).");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) throw new Error(`Refus de vider la base « ${dbName} » : le nom d'une base de test doit contenir « test ».`);
  process.env.DATABASE_URL = url;
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
    await migrate(drizzle(pool), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } finally { await pool.end(); }
}

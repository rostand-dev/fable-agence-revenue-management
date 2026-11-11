import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "node:path";
import * as schema from "./schema";

type Db = NodePgDatabase<typeof schema>;
const g = globalThis as unknown as { __nsPool?: Pool; __nsDb?: Db; __nsMigrated?: Promise<void> };

function pool(): Pool {
  if (!g.__nsPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL manquant");
    g.__nsPool = new Pool({ connectionString: url, max: 10 });
  }
  return g.__nsPool;
}

export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    if (!g.__nsDb) g.__nsDb = drizzle(pool(), { schema });
    return (g.__nsDb as any)[prop];
  },
});

/** Applique les migrations SQL versionnées (idempotent). Appelé au démarrage. */
export function ensureMigrated(): Promise<void> {
  if (!g.__nsMigrated) {
    g.__nsMigrated = migrate(drizzle(pool()), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  }
  return g.__nsMigrated;
}

export { schema };
export function newId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

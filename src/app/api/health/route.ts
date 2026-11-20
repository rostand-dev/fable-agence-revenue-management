import { sql } from "drizzle-orm";
import { db, ensureMigrated } from "@/db";
import { isolationStatus, rlsRequired } from "@/db/tenant";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await ensureMigrated(); await db.execute(sql`select 1`);
    const tenantIsolation = await isolationStatus();
    // isolation exigée (TENANT_RLS=on) mais absente : l'instance ne doit pas être déclarée saine
    if (rlsRequired() && tenantIsolation !== "enforced") return Response.json({ status: "degraded", tenantIsolation }, { status: 503 });
    return Response.json({ status: "ok", tenantIsolation });
  } catch { return Response.json({ status: "degraded" }, { status: 503 }); }
}

import { sql } from "drizzle-orm";
import { db, ensureMigrated } from "@/db";

export const dynamic = "force-dynamic";
export async function GET() {
  try { await ensureMigrated(); await db.execute(sql`select 1`); return Response.json({ status: "ok" }); }
  catch { return Response.json({ status: "degraded" }, { status: 503 }); }
}

// Réécrit les migrations drizzle/*.sql pour qu'elles soient idempotentes. Usage : npm run db:idempotent
import fs from "node:fs";
import path from "node:path";
import { makeIdempotent } from "../src/lib/migrations-idempotent";

const dir = path.join(process.cwd(), "drizzle");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  const p = path.join(dir, f), before = fs.readFileSync(p, "utf8"), after = makeIdempotent(before);
  if (after !== before) { fs.writeFileSync(p, after); console.log("réécrit :", f); }
}

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findNonIdempotent, makeIdempotent } from "./migrations-idempotent";

const SAMPLE = `CREATE TABLE "t" (\n\t"id" text PRIMARY KEY NOT NULL\n);\n--> statement-breakpoint\nALTER TABLE "t" ADD COLUMN "c" integer;--> statement-breakpoint\nALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("id") REFERENCES "public"."u"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint\nCREATE UNIQUE INDEX "t_i" ON "t" USING btree ("id");`;

describe("migrations idempotentes", () => {
  it("détecte puis corrige les instructions rejouables", () => {
    expect(findNonIdempotent(SAMPLE).length).toBe(4);
    const fixed = makeIdempotent(SAMPLE);
    expect(findNonIdempotent(fixed)).toEqual([]);
    expect(fixed).toContain("CREATE TABLE IF NOT EXISTS \"t\"");
    expect(fixed).toContain("ADD COLUMN IF NOT EXISTS \"c\"");
    expect(fixed).toContain("CREATE UNIQUE INDEX IF NOT EXISTS \"t_i\"");
    expect(fixed).toContain("DO $$ BEGIN\n\tALTER TABLE \"t\" ADD CONSTRAINT \"t_fk\"");
    expect(fixed).toContain("EXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;");
  });
  it("la réécriture est elle-même stable (la rejouer ne change rien)", () => {
    const once = makeIdempotent(SAMPLE);
    expect(makeIdempotent(once)).toBe(once);
  });
  it("toutes les migrations du dépôt sont idempotentes (sinon : npm run db:idempotent)", () => {
    const dir = path.join(process.cwd(), "drizzle");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      expect({ f, bad: findNonIdempotent(fs.readFileSync(path.join(dir, f), "utf8")) }).toEqual({ f, bad: [] });
    }
  });
});

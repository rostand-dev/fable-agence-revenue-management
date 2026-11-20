import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { fullMessage } from "@/test/errors";

/** Règle du projet : toute migration est rejouable sans erreur (un preview peut déjà en avoir reçu une version antérieure). */
describe("migrations rejouées sur une base déjà migrée", () => {
  const dir = path.join(process.cwd(), "drizzle");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  it("il y a des migrations", () => expect(files.length).toBeGreaterThan(8));
  for (const f of files) {
    it(`${f} : deux rejeux successifs ne produisent aucune erreur`, async () => {
      const statements = fs.readFileSync(path.join(dir, f), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
      for (let pass = 1; pass <= 2; pass++) {
        for (const st of statements) {
          try { await db.execute(sql.raw(st)); } catch (e) { throw new Error(`${f}, rejeu ${pass} : ${fullMessage(e)}\n${st.slice(0, 200)}`); }
        }
      }
      expect(true).toBe(true);
    });
  }
});

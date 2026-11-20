import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_COVERAGE, ROUTE_COVERAGE } from "./coverage";
import { AUDIT_TYPES, type AuditType } from "./types";

const SRC = path.join(process.cwd(), "src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const read = (f: string) => fs.readFileSync(f, "utf8");
const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f));

describe("couverture du journal d'audit (US-012)", () => {
  it("toute action serveur est déclarée : audit inscrit, ou exemption motivée", () => {
    const declared = new Set(Object.keys(ACTION_COVERAGE));
    const actual = new Set<string>();
    for (const f of files.filter((x) => x.includes(`${path.sep}app${path.sep}actions${path.sep}`))) for (const m of read(f).matchAll(/^export (?:async )?function (\w+)/gm)) actual.add(m[1]);
    expect([...actual].filter((a) => !declared.has(a)), "action non déclarée dans src/lib/audit/coverage.ts").toEqual([]);
    expect([...declared].filter((d) => !actual.has(d)), "déclaration sans action (périmée)").toEqual([]);
  });

  it("toute route d'API qui modifie quelque chose est déclarée", () => {
    const routes = files.filter((f) => f.endsWith(`${path.sep}route.ts`));
    const mutating = routes.filter((f) => /export (?:async )?function (POST|PUT|PATCH|DELETE)\b/.test(read(f))).map((f) => path.relative(path.join(SRC, "app"), path.dirname(f)).split(path.sep).join("/"));
    expect(mutating.filter((r) => !(r in ROUTE_COVERAGE)), "route non déclarée dans src/lib/audit/coverage.ts").toEqual([]);
    for (const r of Object.keys(ROUTE_COVERAGE)) expect(fs.existsSync(path.join(SRC, "app", r, "route.ts")), `route déclarée mais absente : ${r}`).toBe(true);
  });

  it("une exemption donne une vraie raison ; un audit annoncé cite des événements du catalogue", () => {
    for (const [name, c] of [...Object.entries(ACTION_COVERAGE), ...Object.entries(ROUTE_COVERAGE)]) {
      if ("exempt" in c) expect(c.exempt.length, name).toBeGreaterThan(30);
      else { expect(c.events.length, name).toBeGreaterThan(0); for (const e of c.events) expect(e in AUDIT_TYPES, `${name} → ${e}`).toBe(true); }
    }
  });

  it("chaque événement annoncé est réellement écrit quelque part dans le code", () => {
    const corpus = files.filter((f) => !f.includes(`${path.sep}audit${path.sep}`)).map(read).join("\n");
    const claimed = new Set<AuditType>();
    for (const c of Object.values(ACTION_COVERAGE)) if ("events" in c) c.events.forEach((e) => claimed.add(e));
    for (const e of claimed) expect(corpus.includes(`"${e}"`), `événement jamais écrit : ${e}`).toBe(true);
  });

  it("aucun événement du catalogue n'est mort : tous sont écrits par le code", () => {
    const corpus = files.filter((f) => !f.includes(`${path.sep}audit${path.sep}`)).map(read).join("\n");
    for (const t of Object.keys(AUDIT_TYPES)) expect(corpus.includes(`"${t}"`), `type du catalogue jamais utilisé : ${t}`).toBe(true);
  });

  it("le journal ne s'écrit que par recordAudit : aucune insertion directe dans audit_events", () => {
    const offenders = files.filter((f) => !f.includes(`${path.sep}lib${path.sep}audit${path.sep}`) && !f.endsWith(`${path.sep}db${path.sep}schema.ts`) && /auditEvents/.test(read(f))).map((f) => path.relative(SRC, f));
    expect(offenders, "utilisez recordAudit (src/lib/audit/log.ts)").toEqual([]);
  });
});

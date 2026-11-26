import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { can, ROLES } from "@/lib/rbac";
import { ACTION_RIGHTS, ROUTE_RIGHTS } from "./rights-catalog";

const SRC = path.join(process.cwd(), "src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const read = (f: string) => fs.readFileSync(f, "utf8");

describe("catalogue des droits d'écriture", () => {
  it("toute action serveur déclare qui peut l'appeler", () => {
    const actual = walk(path.join(SRC, "app", "actions")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).flatMap((f) => [...read(f).matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]));
    expect(actual.filter((a) => !(a in ACTION_RIGHTS)), "action sans droit déclaré dans src/lib/rights-catalog.ts").toEqual([]);
    expect(Object.keys(ACTION_RIGHTS).filter((d) => !actual.includes(d)), "déclaration sans action (périmée)").toEqual([]);
  });

  it("toute méthode d'API qui modifie déclare qui peut l'appeler", () => {
    const actual = walk(path.join(SRC, "app")).filter((f) => f.endsWith(`${path.sep}route.ts`)).flatMap((f) => {
      const route = path.relative(path.join(SRC, "app"), path.dirname(f)).split(path.sep).join("/");
      return [...read(f).matchAll(/^export (?:(?:async )?function|const) (POST|PUT|PATCH|DELETE)\b/gm)].map((m) => `${m[1]} ${route}`);
    });
    expect(actual.filter((r) => !(r in ROUTE_RIGHTS)), "route sans droit déclaré dans src/lib/rights-catalog.ts").toEqual([]);
    expect(Object.keys(ROUTE_RIGHTS).filter((d) => !actual.includes(d)), "déclaration sans route (périmée)").toEqual([]);
  });

  it("aucune écriture n'échappe au catalogue : actions regroupées, exports reconnus", () => {
    const sources = walk(SRC).filter((f) => /\.[jt]sx?$/.test(f) && !/\.test\.ts$/.test(f));
    const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
    expect(sources.filter((f) => /^\s*["']use server["']/m.test(read(f)) && !rel(f).startsWith("app/actions/")).map(rel), "« use server » hors de src/app/actions").toEqual([]);
    for (const f of sources.filter((x) => rel(x).startsWith("app/actions/"))) expect(read(f).match(/^export (?!(?:async )?function |const |type |interface ).*$/gm) ?? [], `${rel(f)} : export non reconnu`).toEqual([]);
    const routes = sources.filter((f) => /^route\.[jt]sx?$/.test(path.basename(f)));
    expect(routes.filter((f) => !f.endsWith("route.ts")).map(rel), "les routes s'écrivent en route.ts").toEqual([]);
    for (const f of routes) expect(read(f).match(/^export (?!(?:async )?function (?:GET|POST|PUT|PATCH|DELETE)\(|const (?:dynamic|runtime|revalidate|maxDuration)\b).*$/gm) ?? [], `${rel(f)} : export non reconnu`).toEqual([]);
  });

  it("les écritures non gardées à l'entrée sont connues une à une", () => {
    // ajouter une ligne ici est un choix : l'écriture est contrôlée par son service, ou volontairement ouverte
    const unguarded = (t: typeof ACTION_RIGHTS) => Object.entries(t).filter(([, r]) => !("permission" in r)).map(([n]) => n).sort();
    expect(unguarded(ACTION_RIGHTS)).toEqual([
      "acknowledgeAlertAction", "approveAction", "benchModelAction", "chatAction", "confirmSignupAction", "decidePriceAction", "declarePromotionAction", "deferAction", "deletePropertyAction",
      "draftReportAction", "endPromotionAction", "executeAction", "interruptStuckAction", "loginAction", "logoutAction", "logoutEverywhereAction", "rejectAction", "reopenAction",
      "requestPasswordResetAction", "resetPasswordAction", "reviewAction", "rollbackAction", "saveReportAction", "signupAction", "toggleRunbookStepAction", "updatePromotionAction", "verifyAction", "verifyPromotionAction",
    ]);
    expect(unguarded(ROUTE_RIGHTS)).toEqual([
      "DELETE api/v1/properties/[id]", "POST api/chat", "POST api/session/end", "POST api/session/touch", "POST api/v1/opportunities/[id]/approve", "POST api/v1/opportunities/[id]/reject", "POST api/webhooks/superhote/[endpointId]",
    ]);
  });

  it("une écriture ouverte à tous ou déléguée à un service donne sa raison", () => {
    for (const [name, r] of [...Object.entries(ACTION_RIGHTS), ...Object.entries(ROUTE_RIGHTS)]) {
      if ("open" in r) expect(r.open.length, name).toBeGreaterThan(30);
      if ("service" in r) expect(r.service.length, name).toBeGreaterThan(30);
    }
  });

  it("répartition : les logements à trois rôles, l'espace au propriétaire et à l'administrateur", () => {
    expect(ROLES.filter((r) => can(r, "property.manage"))).toEqual(["OWNER", "TENANT_ADMIN", "REVENUE_MANAGER"]);
    expect(ROLES.filter((r) => can(r, "workspace.manage"))).toEqual(["OWNER", "TENANT_ADMIN"]);
  });
});

describe("formulaires verrouillés selon le rôle", () => {
  it("chaque formulaire d'une action gardée annonce le droit exigé", () => {
    const forms = walk(SRC).filter((f) => f.endsWith(".tsx")).flatMap((f) => [...read(f).matchAll(/<ActionForm(?: need="([^"]+)")? action=\{([^{}]+)\}/g)].map((m) => ({ file: path.relative(SRC, f), need: m[1], action: m[2] })));
    const total = walk(SRC).filter((f) => f.endsWith(".tsx")).reduce((n, f) => n + (read(f).match(/<ActionForm\b/g)?.length ?? 0), 0);
    expect(forms.length, "écrire `need` avant `action` sur <ActionForm>").toBe(total);
    let guardedForms = 0;
    for (const f of forms) {
      // `select` : variable qui désigne l'une des deux actions de rattachement du parcours
      const names = f.action === "select" ? ["funnelSelectRentalAction", "funnelSelectListingAction"] : (f.action.match(/\w+Action\b/g) ?? []);
      expect(names.length, `${f.file} : action non reconnue (${f.action})`).toBeGreaterThan(0);
      for (const name of names) {
        const right = ACTION_RIGHTS[name];
        const expected = "permission" in right ? right.permission : undefined;
        if (expected) guardedForms++;
        expect(f.need, `${f.file} : ${name}`).toBe(expected);
      }
    }
    expect(guardedForms).toBeGreaterThan(40);
  });
});

describe("écritures hors d'un <ActionForm>", () => {
  const sources = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f));
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
  const guarded = (name: string) => { const r = ACTION_RIGHTS[name]; return !!r && "permission" in r; };
  /** Appels directs connus : chacun n'est affiché que sur un écran réservé (vérifié plus bas). */
  const direct: Record<string, string[]> = { "components/CostWizard.tsx": ["saveCostsAction"] };

  it("une action gardée ne s'emploie que par un <ActionForm>, qui verrouille les champs", () => {
    for (const f of sources.filter((x) => !rel(x).startsWith("app/actions/"))) {
      const src = read(f);
      const names = [...src.matchAll(/import \{([^}]+)\} from "@\/app\/actions\/[\w-]+";/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())).filter(guarded);
      const rest = src.replace(/^import [^\n]*$/gm, "").replace(/<ActionForm need="[^"]+" action=\{[^{}]+\}/g, "").replace(/^\s*const select = sh \? .*$/gm, "");
      expect(names.filter((n) => new RegExp(`\\b${n}\\b`).test(rest) && !direct[rel(f)]?.includes(n)), rel(f)).toEqual([]);
    }
  });

  it("les écrans qui appellent une action directement, et le parcours de création, sont réservés", () => {
    const screens = sources.filter((f) => rel(f).endsWith("page.tsx") && (rel(f).startsWith("app/(funnel)/") || /<CostWizard\b/.test(read(f))));
    expect(screens.length).toBeGreaterThanOrEqual(3);
    for (const f of screens) {
      expect(read(f), rel(f)).toContain('if (!can(user.role, "property.manage"))');
      expect(read(f), rel(f)).toContain("<Reserved ");
    }
  });
});

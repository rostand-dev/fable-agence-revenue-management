import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * US-075 — Aucune écriture externe depuis les agents (ADR-005, principe 4 de l'épic 7).
 * Contrôle statique, fondé sur le compilateur TypeScript (pas sur des expressions régulières) : chaque module d'agent n'importe que ce qui est autorisé
 * POUR LUI (table par fichier), les dépendances partagées autorisées n'importent elles-mêmes aucune intégration, aucun module n'écrit en base
 * (les traces sont insérées par l'appelant), et seuls la passerelle et le transport Anthropic contactent le réseau, vers des API de modèles.
 * Un nouvel import hors table fait échouer la CI : il doit être justifié et ajouté ici, en relecture.
 */
const DIR = __dirname;
const LIB = join(DIR, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const isSource = (f: string) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f) && !/\.test\.(ts|tsx|mts|cts)$/.test(f);
const files = walk(DIR).filter(isSource);
const name = (f: string) => relative(DIR, f);
const read = (f: string) => readFileSync(f, "utf8");

/** Spécifieurs d'un fichier (imports, ré-exports, import() et require()), lus par le compilateur. */
function specifiers(text: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) out.push(n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : "<dynamique>");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** Jetons du code (arbre TypeScript), sans commentaires, avec chaînes et gabarits remplacés par "" : pour chercher des appels, pas des mots dans un texte. */
function codeOnly(text: string): string {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n)) { out.push('""'); return; }
    const kids = n.getChildren(sf);
    if (kids.length === 0) { out.push(n.getText(sf)); return; }
    kids.forEach(visit);
  };
  visit(sf);
  return out.join(" ");
}

/** Importé par tous les modules d'agents : types et fonctions pures, masquage, chiffrement des clés. */
const SHARED = ["zod", "node:crypto", "../dates", "../format", "../privacy/pii", "../secret", "../engine/types", "../engine/policy"];
/** Autorisations supplémentaires, fichier par fichier. */
const EXTRA: Record<string, string[]> = {
  "runner.ts": ["@/db", "drizzle-orm", "../llm-registry/pricebook", "../llm-registry/cap-state"], // pricebook, cap-state : lecture seule (prix validés, dépense du mois)
  // routeur : registre, prix, plafond, profils et aptitudes en LECTURE seule ; les clés du propriétaire viennent de owner-keys
  "llm-config.ts": ["@/db", "drizzle-orm", "../llm-registry/catalog", "../llm-registry/availability", "../llm-registry/cap-state", "../llm-registry/pricebook", "../llm-registry/profiles", "../llm-registry/router"],
  "owner-keys.ts": ["@/db", "drizzle-orm", "../llm-registry/catalog"],
  "fake-llm-server.ts": ["node:http", "node:net"],
};
/** Seuls ces fichiers contactent le réseau, et seulement ces hôtes. */
const NETWORK = ["gateway.ts", "llm.ts", "owner-keys.ts"];
const HOSTS = ["api.anthropic.com", "api.openai.com", "api.mistral.ai"];

describe("agents : aucune écriture externe (US-075)", () => {
  it("la liste des modules d'agents couvre les agents de l'épic, sans sous-dossier imprévu", () => {
    const names = files.map(name);
    for (const f of ["gateway.ts", "market-analyst.ts", "strategist.ts", "auditor.ts", "runner.ts", "independent-review.ts"]) expect(names, f).toContain(f);
    expect(names.filter((n) => n.includes("/")), "sous-dossier non prévu dans src/lib/agents : étendre le contrôle").toEqual([]);
  });

  it("chaque import d'un module d'agent est autorisé pour CE module (aucun adaptateur d'intégration, aucun service)", () => {
    for (const f of files) {
      const allowed = new Set([...SHARED, ...(EXTRA[name(f)] ?? [])]);
      for (const s of specifiers(read(f))) {
        if (s.startsWith("./")) continue; // modules voisins : tous soumis au même contrôle
        expect(allowed.has(s), `${name(f)} importe « ${s} » : interdit pour ce module d'agent (à ajouter ici seulement après relecture)`).toBe(true);
      }
    }
  });

  it("les dépendances partagées autorisées n'importent elles-mêmes aucune intégration, aucun service ni la base", () => {
    for (const rel of ["engine/policy.ts", "engine/types.ts", "privacy/pii.ts", "secret.ts", "dates.ts", "format.ts"]) {
      for (const s of specifiers(read(join(LIB, rel)))) {
        expect(s, `${rel} importe « ${s} »`).not.toMatch(/integrations|services|@\/db|node:(fs|child_process|http|https|net|module)|drizzle/);
      }
    }
  });

  it("aucun module d'agent n'écrit en base, n'écrit de fichier, ne lance un processus ni n'évalue du code", () => {
    for (const f of files) {
      const c = codeOnly(read(f));
      // `.update(` seul est permis hors accès base : c'est l'API de hachage de node:crypto (createHash(...).update(...)).
      const touchesDb = specifiers(read(f)).some((x) => x === "@/db" || x === "drizzle-orm");
      expect(c, `${name(f)} : écriture en base (les traces sont insérées par l'appelant)`).not.toMatch(touchesDb ? /\.\s*(insert|update|delete|execute|run)\s*\(|\b(insert|update|delete)\s*\(|=\s*db\b\s*[;,)]/ : /\.\s*(insert|delete|execute)\s*\(|\b(insert|delete)\s*\(/);
      expect(c, `${name(f)} : eval / Function`).not.toMatch(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(/);
      expect(c, `${name(f)} : accès bas niveau`).not.toMatch(/process\s*\.\s*(binding|dlopen|kill|exit)|\bchild_process\b|\bwriteFile|\bappendFile|\bcreateWriteStream/);
    }
  });

  it("seuls la passerelle et le transport Anthropic contactent le réseau, et seulement vers des API de modèles", () => {
    const talking = files.filter((f) => /\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bglobalThis\b/.test(codeOnly(read(f))) || specifiers(read(f)).some((s) => /^node:(https?|net|dgram|tls|http2)$/.test(s)));
    expect(talking.map(name).sort()).toEqual([...NETWORK, "fake-llm-server.ts"].sort().filter((n) => talking.map(name).includes(n)));
    for (const f of files.filter((x) => NETWORK.includes(name(x)))) {
      for (const m of read(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) expect(HOSTS, `${name(f)} contacte ${m[1]}`).toContain(m[1]);
    }
    // les modules purs (analyse, avis, seconde lecture, prompts) ne touchent ni le réseau ni la base
    for (const n of ["market-analysis.ts", "strategist-opinions.ts", "independent-review.ts", "prompts.ts"]) {
      const f = files.find((x) => name(x) === n)!;
      expect(specifiers(read(f)).filter((s) => /^(@\/db|drizzle-orm|node:(http|https|net|fs))$/.test(s)), `${n} doit rester pur`).toEqual([]);
    }
  });

  it("le faux serveur de modèle n'écoute qu'en local", () => {
    const f = read(join(DIR, "fake-llm-server.ts"));
    expect(f).toMatch(/127\.0\.0\.1/);
    expect(codeOnly(f)).not.toMatch(/listen\s*\(\s*\w+\s*\)/);
  });

  it("le port PriceLabs n'a aucune méthode d'écriture : seules quatre lectures sont déclarées (l'écriture relève de l'épic 9)", () => {
    const sf = ts.createSourceFile("p.ts", read(join(LIB, "integrations/pricelabs-port.ts")), ts.ScriptTarget.Latest, true);
    const methods: string[] = [];
    sf.forEachChild((n) => { if (ts.isInterfaceDeclaration(n) && n.name.text === "PriceLabsPort") n.members.forEach((m) => { if (ts.isMethodSignature(m)) methods.push(m.name.getText(sf)); }); });
    expect(methods.sort()).toEqual(["getNeighborhood", "getPrices", "getReservations", "listListings"]);
  });

  // Mutation vérifiable : le contrôle détecte bien ce qu'il prétend interdire.
  it("le contrôle détecte un import d'intégration, une écriture en base et un appel réseau injectés (mutation)", () => {
    expect(specifiers('import "../integrations/pricelabs"; export * from "../services/review"; const m = await import("../x"); require("fs");')).toEqual(["../integrations/pricelabs", "../services/review", "../x", "fs"]);
    expect(codeOnly('await db.insert(t).values(v); // db.update\n const s = "db.delete(x)"')).toMatch(/\.\s*insert\s*\(/);
    expect(codeOnly('const s = "db.delete(x)"; // db.insert(t)')).not.toMatch(/\.\s*(insert|delete)\s*\(/);
    expect(/\bfetch\b/.test(codeOnly("const f = fetch; f(url)"))).toBe(true);
  });
});

describe("registre LLM : les modules que les agents importent restent en lecture seule", () => {
  const REG = join(LIB, "llm-registry");
  const readOnly = ["pricebook.ts", "prices.ts", "catalog.ts", "cap-state.ts", "profiles.ts", "router.ts", "availability.ts", "config.ts"];
  const FORBIDDEN_CALLS = /\.(insert|update|delete|execute)\s*\(|\bfetch\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(/;
  it("pricebook, prices et catalog n'écrivent pas en base, n'appellent pas le réseau et n'importent ni synchronisation ni validation ni intégration", () => {
    for (const f of readOnly) {
      const text = readFileSync(join(REG, f), "utf8");
      expect(codeOnly(text), `${f} : écriture ou réseau interdits ici (module importé par les agents)`).not.toMatch(FORBIDDEN_CALLS);
      for (const s of specifiers(text)) expect(["zod", "drizzle-orm", "@/db", "./prices", "./catalog", "./pricebook", "./profiles", "./config", "../agents/registry", "../agents/prompts"].includes(s), `${f} importe « ${s} » : interdit`).toBe(true);
    }
  });
  it("aucun module d'agent n'importe le module qui écrit les prix (validation) ni la synchronisation", () => {
    for (const f of files) for (const s of specifiers(read(f))) expect(/llm-registry\/(price-validation|sync|job|bench|cap(?!-state))/.test(s), `${name(f)} importe « ${s} »`).toBe(false);
  });
});

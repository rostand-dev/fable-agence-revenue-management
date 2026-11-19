import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MONEY_DICTIONARY, isToConfirm } from "./dictionary";
import { renderDictionaryMarkdown } from "./render";

const SRC = resolve(__dirname, "..", "..");
const MONEY_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return p === MONEY_DIR ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
const code = sourceFiles(SRC).map((p) => readFileSync(p, "utf8")).join("\n");
/** Identifiants monétaires du code : `xxxCents` (TypeScript) et `xxx_cents` (colonnes SQL). */
const inCode = new Set(code.match(/\b[a-zA-Z]+Cents\b|\b[a-z]+(?:_[a-z]+)*_cents\b|\b[A-Z]+(?:_[A-Z]+)*_CENTS\b/g) ?? []);
const documented = MONEY_DICTIONARY.flatMap((m) => m.names);
const isToken = (n: string) => /Cents$|_cents$|_CENTS$/.test(n);

describe("dictionnaire des montants", () => {
  it("couvre tous les identifiants monétaires du code", () => {
    const missing = [...inCode].filter((n) => !documented.includes(n)).sort();
    expect(missing, "Ajoutez ces montants à src/lib/money/dictionary.ts").toEqual([]);
  });

  it("ne garde aucun identifiant qui a disparu du code", () => {
    const stale = documented.filter((n) => isToken(n) && !inCode.has(n));
    expect(stale, "Retirez ces noms du dictionnaire").toEqual([]);
  });

  it("n'attribue chaque identifiant qu'à une seule entrée, avec des ids uniques", () => {
    expect(new Set(documented).size).toBe(documented.length);
    const ids = MONEY_DICTIONARY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renseigne chaque champ obligatoire", () => {
    for (const m of MONEY_DICTIONARY) {
      expect(m.id, m.label).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(m.label.length, m.id).toBeGreaterThan(3);
      expect(m.names.length, m.id).toBeGreaterThan(0);
      expect(m.sources.length, m.id).toBeGreaterThan(0);
      expect(m.definition.length, m.id).toBeGreaterThan(20);
      expect(m.currency, m.id).toBe("EUR");
    }
  });

  it("explique comment lever chaque inconnue, sans rien supposer", () => {
    for (const m of MONEY_DICTIONARY) {
      if (isToConfirm(m)) expect(m.toVerify, `${m.id} a une inclusion inconnue sans « toVerify »`).toBeTruthy();
      else expect(m.toVerify, `${m.id} n'a plus d'inconnue : retirez « toVerify »`).toBeUndefined();
    }
  });

  it("documente les montants stockés en base de SuperHote avec la sémantique validée", () => {
    const gross = MONEY_DICTIONARY.find((m) => m.id === "reservation.gross_room")!;
    expect(gross.taxes.cityTax).toBe("EXCLUDED");
    expect(gross.fees.cleaning).toBe("EXCLUDED");
    expect(gross.fees.commission).toBe("INCLUDED");
    const commission = MONEY_DICTIONARY.find((m) => m.id === "reservation.commission")!;
    expect(commission.taxes.vat).toBe("INCLUDED");
    expect(commission.sign).toBe("NON_NEGATIVE");
  });

  it("garde docs/dictionnaire-montants.md synchronisé (npm run docs:money)", () => {
    const committed = readFileSync(resolve(SRC, "..", "docs", "dictionnaire-montants.md"), "utf8");
    expect(committed.replace(/\r\n/g, "\n"), "Le document est périmé : lancez `npm run docs:money` et commitez-le").toBe(renderDictionaryMarkdown());
  });
});

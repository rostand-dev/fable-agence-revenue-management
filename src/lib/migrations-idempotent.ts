/**
 * Règle du projet : tout script de migration BDD doit être idempotent (rejouable sans erreur,
 * par exemple quand un environnement de Preview a déjà reçu une version antérieure d'une migration).
 * drizzle-kit génère du SQL non idempotent : `npm run db:idempotent` le réécrit, et un test échoue sinon.
 */

/** Réécrit les créations (table, index, colonne, contrainte) en versions rejouables. Sans effet sur du SQL déjà idempotent. */
export function makeIdempotent(sql: string): string {
  return sql
    .replace(/^CREATE TABLE (?!IF NOT EXISTS)/gm, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/gm, (_m, u = "") => `CREATE ${u}INDEX IF NOT EXISTS `)
    .replace(/ADD COLUMN (?!IF NOT EXISTS)/g, "ADD COLUMN IF NOT EXISTS ")
    // une contrainte n'a pas de IF NOT EXISTS : on attrape l'erreur « existe déjà » (duplicate_object).
    // Fonction de remplacement obligatoire : dans une chaîne, « $$ » serait lu comme un seul « $ ».
    .replace(/^(ALTER TABLE "[^"]+" ADD CONSTRAINT "[^"]+" [^;]*);/gm, (_m, stmt: string) => "DO $$ BEGIN\n\t" + stmt + ";\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;");
}

/** Instructions qui échoueraient au second passage. Vide = migration idempotente. */
export function findNonIdempotent(sql: string): string[] {
  const bad: string[] = [];
  for (const m of sql.matchAll(/^CREATE TABLE (?!IF NOT EXISTS)[^\n]*/gm)) bad.push(m[0]);
  for (const m of sql.matchAll(/^CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)[^\n]*/gm)) bad.push(m[0]);
  for (const m of sql.matchAll(/ADD COLUMN (?!IF NOT EXISTS)[^\n;]*/g)) bad.push(m[0]);
  for (const m of sql.matchAll(/^ALTER TABLE "[^"]+" ADD CONSTRAINT [^\n]*/gm)) bad.push(m[0]);
  for (const m of sql.matchAll(/^(?:DROP|CREATE TYPE|CREATE EXTENSION|CREATE SCHEMA)[^\n]*/gm)) if (!/IF (NOT )?EXISTS/.test(m[0])) bad.push(m[0]);
  return bad;
}

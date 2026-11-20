/** Message complet d'une erreur, cause comprise (drizzle enveloppe l'erreur PostgreSQL dans « Failed query »). */
export function fullMessage(e: unknown): string {
  const out: string[] = [];
  for (let x: any = e, i = 0; x && i < 5; x = x.cause, i++) out.push(String(x.message ?? x));
  return out.join(" | ");
}
/** Attend que la promesse échoue, et renvoie le message complet pour l'examiner. */
export async function failure(p: PromiseLike<unknown>): Promise<string> {
  try { await p; } catch (e) { return fullMessage(e); }
  throw new Error("la requête aurait dû échouer");
}

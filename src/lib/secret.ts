import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Chiffrement au repos des secrets d'intégration (clés API). AES-256-GCM, clé dérivée de APP_SECRET.
 * Sans APP_SECRET, aucun secret n'est enregistré : on refuse plutôt que de stocker en clair.
 */
function key(): Buffer {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error("APP_SECRET manquant sur le serveur : impossible d'enregistrer une clé API de façon sûre.");
  return createHash("sha256").update(s).digest();
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
export function decryptSecret(stored: string): string {
  const [v, iv, tag, enc] = stored.split(".");
  if (v !== "v1") throw new Error("Format de secret inconnu");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}
export const secretHint = (plain: string) => "••••" + plain.slice(-4);

/**
 * Raccourcit un texte coupé par la limite de longueur à sa dernière phrase complète.
 * Sans phrase complète exploitable (moins de 20 caractères avant la coupure), le texte est gardé et suivi de « … ».
 */
export function trimToLastSentence(text: string): string {
  const t = text.trimEnd();
  if (/[.!?…»)]$/.test(t)) return t;
  let cut = -1;
  const re = /[.!?…](?:["»)\]]*)(?=\s|$)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) cut = m.index + m[0].length;
  if (cut >= 20) return t.slice(0, cut).trimEnd();
  return t.replace(/[\s,;:(–-]+$/, "") + " …";
}

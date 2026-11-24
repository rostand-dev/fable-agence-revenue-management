/** Lecture des variables d'environnement du routeur LLM. Chaque variable est décrite dans .env.example et docker-compose.yml. */
export const DEFAULT_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Adresse du fichier de prix (LLM_PRICES_URL). Doit être en https ; sinon l'adresse par défaut est utilisée. */
export function pricesUrl(env: Record<string, string | undefined> = process.env): string {
  const v = env.LLM_PRICES_URL?.trim();
  if (!v) return DEFAULT_PRICES_URL;
  try { const u = new URL(v); return u.protocol === "https:" || (u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) ? v : DEFAULT_PRICES_URL; } catch { return DEFAULT_PRICES_URL; }
}

/** Fréquence du job en heures (LLM_SYNC_INTERVAL_HOURS) : défaut 24, de 1 à 168 ; 0 désactive le job (tests, CI). Valeur invalide : défaut. */
export function syncIntervalHours(env: Record<string, string | undefined> = process.env): number {
  const v = env.LLM_SYNC_INTERVAL_HOURS?.trim();
  if (v === undefined || v === "") return 24;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 168 ? n : 24;
}

/** Taux de conversion USD → EUR (LLM_USD_EUR_RATE), fixe : défaut 0,92, entre 0,1 et 10. Valeur invalide : défaut. */
export const DEFAULT_USD_EUR_RATE = 0.92;
export function usdEurRate(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.LLM_USD_EUR_RATE ?? "").trim().replace(",", "."));
  return Number.isFinite(n) && n >= 0.1 && n <= 10 ? n : DEFAULT_USD_EUR_RATE;
}

/** Adresse de l'API Mistral (MISTRAL_API_BASE), pour les tests avec un faux serveur. Défaut : https://api.mistral.ai. */
export const mistralBase = (env: Record<string, string | undefined> = process.env): string => (env.MISTRAL_API_BASE?.trim() || "https://api.mistral.ai").replace(/\/$/, "");

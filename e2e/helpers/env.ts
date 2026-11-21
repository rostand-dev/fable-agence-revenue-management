/** Identifiants HTTP Basic de la Preview (E2E_HTTP_USER / E2E_HTTP_PASSWORD) ; absents si l'environnement testé n'est pas protégé. */
const origin = new URL((process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3000")).origin;
// `origin` : les identifiants ne sont envoyés qu'à l'application testée, jamais à un autre hôte qui lancerait un défi 401 (redirection).
export const httpCredentials = process.env.E2E_HTTP_USER && process.env.E2E_HTTP_PASSWORD
  ? { username: process.env.E2E_HTTP_USER, password: process.env.E2E_HTTP_PASSWORD, origin }
  : undefined;

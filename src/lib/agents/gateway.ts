/**
 * Passerelle LLM multi-fournisseur à sorties JSON (US-070, blueprint ADR-004).
 *
 * Une seule porte d'entrée pour tout ce que les agents demandent à un modèle de langage :
 *  - un FOURNISSEUR est un adaptateur minimal (`LlmProvider`) : Anthropic, OpenAI (repli du serveur, facultatif) ou scripté (tests, golden cases) ;
 *  - une CIBLE (`GatewayTarget`) = un fournisseur + une clé + un modèle ; la liste de cibles est ordonnée : en cas d'échec, la suivante prend le relais ;
 *  - la SORTIE est toujours un objet JSON validé par un schéma Zod. Une sortie invalide déclenche une seule demande de correction, puis un changement de cible ;
 *  - tout texte envoyé est masqué avant l'appel (US-034), quel que soit le fournisseur ;
 *  - la passerelle n'échoue jamais en exception : elle renvoie `{ ok: false, kind }` et l'appelant retombe sur son repli déterministe.
 *
 * Règle d'architecture (ADR-005) : un modèle rédige, classe ou commente ; il ne calcule aucun montant et n'écrit nulle part.
 * Ce module ne connaît ni la base ni les adaptateurs d'écriture : il ne peut donc rien exécuter.
 */
import { z } from "zod";
import { maskPii } from "../privacy/pii";
import { callLlm, LlmError } from "./llm";

export type ProviderId = "anthropic" | "openai" | "scripted";
export type ProviderRequest = { model: string; system: string; user: string; maxTokens: number; timeoutMs: number };
export type ProviderReply = { text: string; inputTokens: number | null; outputTokens: number | null; truncated: boolean };
export interface LlmProvider {
  id: ProviderId;
  complete(apiKey: string, req: ProviderRequest): Promise<ProviderReply>;
}

/** Un fournisseur, la clé à utiliser et le modèle demandé. `source` dit d'où vient la clé (affichage et traces). */
export type GatewayTarget = { provider: LlmProvider; apiKey: string; model: string; source: "utilisateur" | "serveur" };

// ───────────────────────── Fournisseurs ─────────────────────────

/** Anthropic : réutilise le transport existant (`callLlm`), donc les mêmes messages d'erreur clairs et le même masquage. */
export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  async complete(apiKey, req) {
    const r = await callLlm({ apiKey, model: req.model, source: "utilisateur" }, { system: req.system, messages: [{ role: "user", content: req.user }], maxTokens: req.maxTokens, timeoutMs: req.timeoutMs });
    return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, truncated: r.truncated };
  },
};

const openaiBase = () => (process.env.OPENAI_API_BASE || "https://api.openai.com").replace(/\/$/, "");

/** OpenAI (API « chat completions », mode JSON) : repli facultatif du serveur, jamais la clé d'un propriétaire. Réservé à `generateJson`, qui masque les données personnelles avant l'appel. */
export const openaiProvider: LlmProvider = {
  id: "openai",
  async complete(apiKey, req) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    let res: Response;
    try {
      res = await fetch(openaiBase() + "/v1/chat/completions", {
        method: "POST", signal: ctrl.signal, cache: "no-store",
        headers: { authorization: "Bearer " + apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: req.model, max_completion_tokens: req.maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }] }),
      });
    } catch (e: any) {
      clearTimeout(timer);
      throw new LlmError(e?.name === "AbortError" ? "OpenAI n'a pas répondu à temps." : "OpenAI est injoignable depuis le serveur.");
    }
    if (!res.ok) { clearTimeout(timer); throw new LlmError(res.status === 401 ? "Clé API refusée par OpenAI." : res.status === 429 ? "Trop de requêtes vers OpenAI." : `OpenAI a répondu par une erreur (HTTP ${res.status}).`, res.status); }
    let data: any;
    try { data = await res.json(); } catch { throw new LlmError("Réponse OpenAI illisible ou trop lente."); } finally { clearTimeout(timer); }
    const choice = data?.choices?.[0];
    return {
      text: typeof choice?.message?.content === "string" ? choice.message.content.trim() : "",
      inputTokens: data?.usage?.prompt_tokens ?? null, outputTokens: data?.usage?.completion_tokens ?? null, truncated: choice?.finish_reason === "length",
    };
  },
};

/**
 * Fournisseur scripté (tests, golden cases, démonstrations hors ligne) : aucune requête réseau, la réponse vient d'une fonction.
 * Une réponse qui est une `Error` simule une panne du fournisseur.
 */
export function scriptedProvider(respond: (req: ProviderRequest, callIndex: number) => string | Error | Promise<string | Error>): LlmProvider & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  return {
    id: "scripted", calls,
    async complete(_apiKey, req) {
      calls.push(req);
      const out = await respond(req, calls.length - 1);
      if (out instanceof Error) throw out instanceof LlmError ? out : new LlmError("Panne simulée du fournisseur scripté.");
      return { text: out, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(out.length / 4), truncated: false };
    },
  };
}

// ───────────────────────── Sortie JSON ─────────────────────────

/** Premier objet JSON de la réponse : tolère un bloc ``` et du texte autour, lit les accolades en respectant les chaînes. `null` si aucun objet complet. */
export function parseJsonObject(text: string): unknown | null {
  // borné (entrée hostile) : 64 Ko analysés, 20 points de départ essayés. La première accolade qui donne un objet valide gagne ; le schéma de l'appelant borne ce que cela permet.
  const src = text.slice(0, 65536).replace(/^[ \t]*```(?:json)?[ \t]*$/gim, "");
  for (let start = src.indexOf("{"), tries = 0; start >= 0 && tries < 20; start = src.indexOf("{", start + 1), tries++) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { const v = JSON.parse(src.slice(start, i + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* essayer l'accolade suivante */ }
        break;
      }
    }
  }
  return null;
}

/** Description du schéma donnée au modèle (JSON Schema compact). Un schéma que Zod ne sait pas décrire est simplement omis. */
export function schemaHint(schema: z.ZodType): string {
  try {
    const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
    void $schema;
    return JSON.stringify(rest);
  } catch { return ""; }
}

/** Raison lisible d'un échec de validation, sans jamais citer la valeur reçue (elle peut contenir du contenu non fiable). */
export function describeIssues(err: z.ZodError): string {
  // seuls le code de l'erreur et un chemin de forme sûre sont repris : un message ou une clé venus du modèle ne sont jamais renvoyés au modèle ni conservés
  const safePath = (p: PropertyKey[]) => p.map(String).filter((k) => /^[\w-]{1,40}$/.test(k)).join(".") || "(racine)";
  // les messages « custom » sont rédigés par nous (superRefine), jamais par le modèle : ils aident la correction
  return err.issues.slice(0, 5).map((i) => `${safePath(i.path)} : ${i.code === "custom" ? i.message : i.code}`).join(" ; ").slice(0, 400);
}

// ───────────────────────── Appel ─────────────────────────

export type JsonCall<T> = {
  /** Nom stable de la tâche (traces, journal) ; jamais envoyé tel quel hors du système. */
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  timeoutMs?: number;
  /** Une demande de correction après une sortie invalide (défaut : oui). */
  repair?: boolean;
  /** Plafond d'appels au fournisseur pour cette tâche, corrections comprises (défaut 4). */
  maxAttempts?: number;
  /** Durée totale maximale de la tâche, en ms (défaut 45 000) : aucun nouvel appel n'est lancé au-delà. */
  deadlineMs?: number;
};

/** `inputTokens` / `outputTokens` : jetons facturés pour cette cible (corrections comprises), absents si le fournisseur ne les a pas déclarés : sert au coût réel par modèle. */
export type TriedTarget = { provider: ProviderId; model: string; outcome: "OK" | "PROVIDER_ERROR" | "INVALID_JSON" | "SCHEMA" | "TRUNCATED"; detail?: string; inputTokens?: number; outputTokens?: number };
export type GatewayMeta = {
  provider: ProviderId | null; model: string | null; source: GatewayTarget["source"] | null;
  /** Appels réellement faits au fournisseur (corrections comprises). */
  attempts: number; repaired: boolean; inputTokens: number; outputTokens: number; durationMs: number; tried: TriedTarget[];
};
export type GatewayFailure = "NO_PROVIDER" | "PROVIDER_ERROR" | "INVALID_OUTPUT" | "BUDGET";
export type GatewayResult<T> = { ok: true; data: T; meta: GatewayMeta } | { ok: false; kind: GatewayFailure; message: string; meta: GatewayMeta };

const emptyMeta = (): GatewayMeta => ({ provider: null, model: null, source: null, attempts: 0, repaired: false, inputTokens: 0, outputTokens: 0, durationMs: 0, tried: [] });

function errorText(e: unknown): string {
  // seuls les messages de LlmError (rédigés ici, sans clé ni corps de réponse) sont repris ; le reste reste générique
  return e instanceof LlmError ? e.message : "Erreur inattendue du fournisseur.";
}

/**
 * Demande une sortie JSON conforme à `call.schema`. Ordre : première cible, correction éventuelle, cible suivante, etc.
 * `data` est la sortie validée par le schéma : c'est le seul contenu du modèle qui sorte d'ici.
 */
export async function generateJson<T>(targets: GatewayTarget[], call: JsonCall<T>): Promise<GatewayResult<T>> {
  const meta = emptyMeta();
  if (targets.length === 0) return { ok: false, kind: "NO_PROVIDER", message: "Aucun fournisseur de modèle n'est configuré : repli déterministe.", meta };
  const started = Date.now();
  const hint = schemaHint(call.schema);
  const system = maskPii(call.system) + "\n\nRéponds uniquement par UN objet JSON valide, sans texte autour ni bloc de code." + (hint ? `\nSchéma JSON attendu : ${hint}` : "");
  const user = maskPii(call.user);
  const maxAttempts = call.maxAttempts ?? 4, deadline = started + (call.deadlineMs ?? 45000), maxTokens = call.maxTokens ?? 900, timeoutMs = call.timeoutMs ?? 25000;
  let sawInvalid = false, cut = false, ownerKeyRefused = false;

  const ask = async (t: GatewayTarget, prompt: string, row: TriedTarget): Promise<ProviderReply> => {
    if (Date.now() >= deadline) { cut = true; throw new LlmError("Délai total dépassé."); }
    meta.attempts++;
    const r = await t.provider.complete(t.apiKey, { model: t.model, system, user: prompt, maxTokens, timeoutMs });
    meta.inputTokens += r.inputTokens ?? 0; meta.outputTokens += r.outputTokens ?? 0;
    if (r.inputTokens != null) row.inputTokens = (row.inputTokens ?? 0) + r.inputTokens;
    if (r.outputTokens != null) row.outputTokens = (row.outputTokens ?? 0) + r.outputTokens;
    return r;
  };
  const check = (r: ProviderReply): { ok: true; data: T } | { ok: false; outcome: "INVALID_JSON" | "SCHEMA" | "TRUNCATED"; detail: string } => {
    const obj = parseJsonObject(r.text);
    if (obj === null) return { ok: false, outcome: r.truncated ? "TRUNCATED" : "INVALID_JSON", detail: r.truncated ? "Réponse coupée par la limite de longueur." : "Aucun objet JSON dans la réponse." };
    const v = call.schema.safeParse(obj);
    return v.success ? { ok: true, data: v.data } : { ok: false, outcome: "SCHEMA", detail: describeIssues(v.error) };
  };

  for (const t of targets) {
    if (meta.attempts >= maxAttempts) { cut = true; break; }
    // la clé du propriétaire refusée (401/403) n'est pas une panne : ses données ne partent pas chez un autre fournisseur à son insu
    if (ownerKeyRefused && t.source === "serveur") break;
    const row: TriedTarget = { provider: t.provider.id, model: t.model, outcome: "OK" };
    try {
      let r = await ask(t, user, row);
      let v = check(r);
      if (!v.ok) sawInvalid = true;
      if (!v.ok && v.outcome !== "TRUNCATED" && (call.repair ?? true) && meta.attempts < maxAttempts) {
        // une seule correction : on donne la raison de l'échec, jamais la réponse invalide (elle pourrait reprendre du contenu non fiable)
        r = await ask(t, `${user}\n\nTa réponse précédente a été refusée (${v.detail}). Réponds à nouveau par un seul objet JSON conforme au schéma.`, row);
        v = check(r);
        if (v.ok) meta.repaired = true;
      }
      if (v.ok) {
        row.outcome = "OK"; meta.tried.push(row);
        meta.provider = t.provider.id; meta.model = t.model; meta.source = t.source; meta.durationMs = Date.now() - started;
        return { ok: true, data: v.data, meta };
      }
      row.outcome = v.outcome; row.detail = v.detail;
    } catch (e) {
      row.outcome = "PROVIDER_ERROR"; row.detail = errorText(e);
      if (e instanceof LlmError && (e.status === 401 || e.status === 403) && t.source === "utilisateur") ownerKeyRefused = true;
    }
    meta.tried.push(row);
  }
  meta.durationMs = Date.now() - started;
  const last = meta.tried[meta.tried.length - 1];
  return { ok: false, kind: cut && !sawInvalid ? "BUDGET" : sawInvalid ? "INVALID_OUTPUT" : "PROVIDER_ERROR", message: last?.detail ? `${last.detail} Repli déterministe.` : "Aucune réponse exploitable : repli déterministe.", meta };
}

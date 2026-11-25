/**
 * Faux serveur de modèles de langage (tests uniquement) : imite les API Anthropic (`POST /v1/messages`), OpenAI (`POST /v1/chat/completions`) et Mistral (même forme, sous le préfixe `/mistral`, car MISTRAL_API_BASE y pointe), ainsi que `GET /v1/models` de chacune
 * pour que la passerelle soit testée de bout en bout, requêtes HTTP réelles comprises, sans clé ni réseau externe.
 * La réponse est fournie par une fonction : elle reçoit le fournisseur appelé, le système et le message utilisateur.
 * Une réponse de type `{ status }` simule une panne HTTP.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeLlmRequest = { provider: "anthropic" | "openai" | "mistral"; apiKey: string; model: string; system: string; user: string; body: any };
export type FakeLlmReply = string | { status: number } | { text: string; stopReason?: string };
export type FakeLlmServer = { url: string; requests: FakeLlmRequest[]; close: () => Promise<void> };

export async function startFakeLlmServer(respond: (req: FakeLlmRequest, index: number) => FakeLlmReply | Promise<FakeLlmReply>, port = 0): Promise<FakeLlmServer> {
  const requests: FakeLlmRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = req.url ?? "";
      if (url === "/__health") { res.writeHead(200).end("ok"); return; }
      // liste des modèles : de quoi vérifier une clé saisie (la forme change selon le fournisseur ; la clé n'est jamais vérifiée ici)
      const modelsPath = url.split("?")[0].match(/^(\/mistral)?\/v1\/models$/);
      if (req.method === "GET" && modelsPath) {
        const isAnthropic = !modelsPath[1] && !!req.headers["x-api-key"], isMistral = !!modelsPath[1];
        const ids = isAnthropic ? ["claude-haiku-5-5", "claude-sonnet-5-5"] : isMistral ? ["mistral-small-2603"] : ["gpt-6-luna", "gpt-6.1-terra"];
        const data = isAnthropic ? ids.map((id) => ({ id, display_name: id, created_at: "2026-01-01T00:00:00Z" })) : ids.map((id) => ({ id, object: "model", created: 1767225600 }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data, has_more: false }));
        return;
      }
      const mistral = url.startsWith("/mistral/v1/chat/completions");
      const anthropic = url.startsWith("/v1/messages"), openai = url.startsWith("/v1/chat/completions") || mistral;
      if (req.method !== "POST" || (!anthropic && !openai)) { res.writeHead(404).end("{}"); return; }
      let body: any = {};
      try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400).end("{}"); return; }
      const user = anthropic ? String(body.messages?.[body.messages.length - 1]?.content ?? "") : String(body.messages?.find((m: any) => m.role === "user")?.content ?? "");
      const system = anthropic ? String(body.system ?? "") : String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
      const apiKey = anthropic ? String(req.headers["x-api-key"] ?? "") : String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const call: FakeLlmRequest = { provider: anthropic ? "anthropic" : mistral ? "mistral" : "openai", apiKey, model: String(body.model ?? ""), system, user, body };
      requests.push(call);
      const out = await respond(call, requests.length - 1);
      if (typeof out === "object" && "status" in out) { res.writeHead(out.status, { "content-type": "application/json" }).end("{}"); return; }
      const text = typeof out === "string" ? out : out.text, stop = typeof out === "string" ? undefined : out.stopReason;
      if (anthropic && body.stream) {
        // flux SSE minimal, tel que l'API Anthropic l'envoie : début, morceaux de texte, fin avec la raison d'arrêt
        const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(ev("message_start", { type: "message_start", message: { usage: { input_tokens: Math.ceil((system.length + user.length) / 4) } } }));
        for (const chunk of text.match(/.{1,40}/gs) ?? [text]) res.write(ev("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: chunk } }));
        res.end(ev("message_delta", { type: "message_delta", delta: { stop_reason: stop ?? "end_turn" }, usage: { output_tokens: Math.ceil(text.length / 4) } }));
        return;
      }
      const payload = anthropic
        ? { content: [{ type: "text", text }], usage: { input_tokens: Math.ceil((system.length + user.length) / 4), output_tokens: Math.ceil(text.length / 4) }, stop_reason: stop ?? "end_turn" }
        : { choices: [{ message: { content: text }, finish_reason: stop === "max_tokens" ? "length" : "stop" }], usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: Math.ceil(text.length / 4) } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, requests, close: () => new Promise((ok) => server.close(() => ok())) };
}

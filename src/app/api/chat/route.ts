import { getUser } from "@/lib/auth";
import { streamLlm } from "@/lib/agents/llm";
import { CHAT_MAX_TOKENS, finishChat, prepareChat } from "@/lib/services/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Échange avec un agent, en flux : une ligne JSON par événement.
 *   {"t":"delta","text":"…"}  morceau de texte (modèle de langage)
 *   {"t":"done","message":{…}} réponse enregistrée, texte final (éventuellement raccourci)
 *   {"t":"error","error":"…"}  échec avant toute réponse
 * Sans clé API, la réponse par règles arrive d'un coup, après une courte pause.
 */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Session expirée : reconnectez-vous." }, { status: 401 });
  const origin = req.headers.get("origin"), host = req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return Response.json({ error: "Requête refusée." }, { status: 403 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Requête illisible." }, { status: 400 }); }
  const question = String(body?.question ?? "").trim().slice(0, 600);
  if (question.length < 2) return Response.json({ error: "Écrivez une question." }, { status: 400 });
  const agentId = String(body?.agentId ?? ""), opportunityId = body?.opportunityId ? String(body.opportunityId) : null;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* navigateur parti */ } };
      try {
        const c = await prepareChat(user.tenantId, agentId, opportunityId, question);
        let r = null, err: unknown;
        if (c.llm) {
          try { r = await streamLlm(c.llm, { system: c.system, messages: c.messages, maxTokens: CHAT_MAX_TOKENS }, (text) => send({ t: "delta", text })); }
          catch (e) { err = e; }
        } else await new Promise((res) => setTimeout(res, 500));
        const m = await finishChat(c, r, err);
        send({ t: "done", message: { id: m.id, content: m.content, mode: m.mode, createdAt: m.createdAt.toISOString() }, fallbackError: err ? String((err as any)?.message ?? err) : undefined });
      } catch (e) {
        console.error(e);
        send({ t: "error", error: "Une erreur technique est survenue. Réessayez." });
      } finally { try { ctrl.close(); } catch { /* déjà fermé */ } }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}

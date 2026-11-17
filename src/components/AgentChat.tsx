"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { fmtDateTime } from "@/lib/dates";

export type ChatTurn = { id: string; role: "user" | "agent"; content: string; mode: string | null; createdAt: string };
type Pending = { question: string; text: string; started: boolean } | null;

/**
 * Conversation avec un agent, à la manière du chat Claude : la question s'affiche tout de suite,
 * l'agent « réfléchit », puis sa réponse s'écrit au fil de l'eau. Le serveur enregistre l'échange (POST /api/chat).
 */
export function AgentChat({ agentId, opportunityId, agentLabel, initial, shortcuts, placeholder, emptyText, markPrefix = "", inputId = "q" }: {
  agentId: string; opportunityId: string | null; agentLabel: string; initial: ChatTurn[]; shortcuts: string[]; placeholder: string; emptyText: string; markPrefix?: string; inputId?: string;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>(initial);
  const [pending, setPending] = useState<Pending>(null);
  const [failed, setFailed] = useState<{ question: string; error: string } | null>(null);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null), areaRef = useRef<HTMLTextAreaElement>(null), stick = useRef(true), busy = useRef(false);

  // Garde le bas visible, sauf si la personne a remonté pour relire.
  useEffect(() => { const el = logRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [turns, pending, failed]);
  const onScroll = () => { const el = logRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; };
  const grow = () => { const el = areaRef.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; } };

  async function send(raw: string) {
    const question = raw.trim().slice(0, 600);
    if (question.length < 2 || busy.current) return;
    busy.current = true; stick.current = true;
    setFailed(null); setDraft(""); requestAnimationFrame(grow);
    setPending({ question, text: "", started: false });
    let answered = false;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, opportunityId, question }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? "Le serveur n'a pas répondu. Réessayez.");
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", text = "";
      const handle = (line: string) => {
        if (!line.trim()) return;
        const ev = JSON.parse(line);
        if (ev.t === "delta") { text += ev.text; setPending({ question, text, started: true }); }
        else if (ev.t === "done") {
          answered = true;
          const now = new Date().toISOString();
          setTurns((t) => [...t, { id: "u-" + ev.message.id, role: "user", content: question, mode: null, createdAt: now }, { id: ev.message.id, role: "agent", content: ev.message.content, mode: ev.message.mode, createdAt: ev.message.createdAt }]);
          setPending(null);
        } else if (ev.t === "error") throw new Error(ev.error);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      handle(buf);
      if (!answered) throw new Error("La réponse a été interrompue. Réessayez.");
    } catch (e: any) {
      setPending(null);
      setFailed({ question, error: e instanceof TypeError ? "Connexion impossible. Vérifiez votre réseau, puis réessayez." : e?.message ?? "Une erreur est survenue. Réessayez." });
    } finally { busy.current = false; areaRef.current?.focus({ preventScroll: true }); }
  }

  const mark = (m: ChatTurn) => <span className="talk-mark">{markPrefix}{m.mode === "LLM" ? "modèle de langage" : "composée par règles"} · {fmtDateTime(new Date(m.createdAt))}</span>;
  const sending = pending !== null;
  return (
    <>
      <div className="talk-log" role="log" aria-live="polite" aria-busy={sending} ref={logRef} onScroll={onScroll} tabIndex={0} aria-label={`Conversation avec ${agentLabel}`}>
        {turns.length === 0 && !sending && !failed && <p className="muted" style={{ margin: 0 }}>{emptyText}</p>}
        {turns.map((m) => (
          <div key={m.id} className={`talk-turn${m.role === "user" ? " is-me" : ""}`}>
            <span className="talk-who">{m.role === "user" ? "Vous" : agentLabel}</span>
            <div className="talk-bubble">{m.content}{m.role !== "user" && mark(m)}</div>
          </div>
        ))}
        {(pending || failed) && (
          <div className="talk-turn is-me"><span className="talk-who">Vous</span><div className="talk-bubble">{(pending ?? failed)!.question}</div></div>
        )}
        {pending && (
          <div className="talk-turn" data-state={pending.started ? "streaming" : "thinking"}>
            <span className="talk-who">{agentLabel}</span>
            <div className="talk-bubble">
              {pending.started
                ? <>{pending.text}<span className="talk-caret" aria-hidden="true" /></>
                : <span className="talk-typing" role="status"><span className="talk-dots" aria-hidden="true"><i /><i /><i /></span>{agentLabel} réfléchit…</span>}
            </div>
          </div>
        )}
        {failed && (
          <div className="talk-turn" data-state="error">
            <span className="talk-who">{agentLabel}</span>
            <div className="talk-bubble talk-error" role="alert"><Icon name="alert" /><span>{failed.error}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => send(failed.question)}>Réessayer</button></div>
          </div>
        )}
      </div>
      <div className="talk-form">
        <div className="talk-shortcuts">{shortcuts.map((q) => <button key={q} type="button" className="btn btn-ghost btn-sm" disabled={sending} onClick={() => send(q)}>{q}</button>)}</div>
        <form onSubmit={(e) => { e.preventDefault(); send(draft); }}>
          <div className="talk-row">
            <label className="visually-hidden" htmlFor={inputId}>Votre question</label>
            <textarea id={inputId} ref={areaRef} rows={1} maxLength={600} value={draft} placeholder={placeholder} enterKeyHint="send" disabled={false}
              onChange={(e) => { setDraft(e.target.value); grow(); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }} />
            <button type="submit" className="btn btn-primary" disabled={sending || draft.trim().length < 2} aria-disabled={sending}><Icon name={sending ? "spin" : "send"} />{sending ? "Envoi…" : "Envoyer"}</button>
          </div>
        </form>
      </div>
    </>
  );
}

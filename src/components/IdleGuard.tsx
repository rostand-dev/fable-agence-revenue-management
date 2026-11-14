"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_MS, WARNING_MS } from "@/lib/session-policy";

const KEY = "ns_last_activity";
/** Signal envoyé au serveur au plus toutes les 4 min tant que l'utilisateur est actif (l'échéance serveur est de 15 min). */
const KEEPALIVE_MS = 4 * 60_000;
const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll", "pointermove"] as const;

function readShared(): number | null {
  try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}
function writeShared(t: number) {
  try { localStorage.setItem(KEY, String(t)); } catch { /* stockage indisponible : on reste sur le suivi de cet onglet */ }
}

/**
 * Déconnecte après 15 min sans activité (clic, frappe, défilement, toucher), tous onglets confondus.
 * Une minute avant, un dialogue propose de rester connecté. Le serveur reste l'autorité : même sans ce composant,
 * la session expire après 15 min sans requête.
 */
export function IdleGuard() {
  const dialog = useRef<HTMLDialogElement>(null);
  const last = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const sharedWrite = useRef(0);
  const ending = useRef(false);
  const warning = useRef(false);
  const [left, setLeft] = useState<number | null>(null);

  const logout = useCallback(async () => {
    if (ending.current) return;
    ending.current = true;
    try { await fetch("/api/session/end", { method: "POST", keepalive: true }); } catch { /* le serveur aura de toute façon expiré la session */ }
    window.location.assign("/connexion?expire=1");
  }, []);

  const ping = useCallback(async () => {
    lastPing.current = Date.now();
    try {
      const r = await fetch("/api/session/touch", { method: "POST", keepalive: true });
      if (r.status === 401) logout();
    } catch { /* réseau coupé : on réessaiera au prochain palier */ }
  }, [logout]);

  const stay = useCallback(() => {
    const now = Date.now();
    last.current = now; writeShared(now);
    warning.current = false; setLeft(null);
    ping();
  }, [ping]);

  useEffect(() => {
    const shared = readShared();
    if (shared && shared > last.current - IDLE_MS) last.current = Math.max(last.current, shared);
    writeShared(last.current);

    const onActivity = () => {
      if (warning.current || ending.current) return; // pendant l'avertissement, seul « Rester connecté » compte
      const now = Date.now();
      last.current = now;
      if (now - sharedWrite.current > 5_000) { sharedWrite.current = now; writeShared(now); }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY || !e.newValue) return;
      const t = Number(e.newValue);
      if (Number.isFinite(t) && t > last.current) {
        last.current = t;
        if (warning.current) { warning.current = false; setLeft(null); } // activité dans un autre onglet
      }
    };
    const tick = () => {
      if (ending.current) return;
      const now = Date.now();
      const idle = now - last.current;
      if (idle >= IDLE_MS) { logout(); return; }
      if (idle >= IDLE_MS - WARNING_MS) {
        warning.current = true;
        setLeft(Math.ceil((IDLE_MS - idle) / 1000));
        return;
      }
      if (warning.current) { warning.current = false; setLeft(null); }
      if (last.current > lastPing.current && now - lastPing.current >= KEEPALIVE_MS) ping();
    };

    EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { capture: true, passive: true }));
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", tick); // réveil d'un onglet ou d'un poste en veille : on tranche tout de suite
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => {
      EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity, { capture: true }));
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", tick);
      window.clearInterval(timer);
    };
  }, [logout, ping]);

  useEffect(() => {
    const d = dialog.current; if (!d) return;
    if (left !== null && !d.open) d.showModal();
    if (left === null && d.open) d.close();
  }, [left]);

  return (
    <dialog className="idle-dialog" ref={dialog} aria-labelledby="idle-title" aria-describedby="idle-desc"
      onCancel={(e) => { e.preventDefault(); stay(); }}>
      <h2 id="idle-title">Toujours là ?</h2>
      <p id="idle-desc" className="muted">
        Sans activité de votre part, vous serez déconnecté(e) dans <strong>{left ?? 0} s</strong>. Ce qui n'est pas enregistré sera perdu.
      </p>
      <div className="idle-actions">
        <button type="button" className="btn btn-primary" autoFocus onClick={stay}>Rester connecté(e)</button>
        <button type="button" className="btn btn-ghost" onClick={logout}>Me déconnecter</button>
      </div>
    </dialog>
  );
}

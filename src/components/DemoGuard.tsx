"use client";
import { useEffect, useState } from "react";
import { DEMO_READONLY_MESSAGE } from "@/lib/demo-mode";

/**
 * Démo en lecture seule : un envoi de formulaire est intercepté avant d'atteindre le serveur et explique pourquoi rien ne se passe.
 * Le vrai verrou est côté serveur (middleware) ; ceci n'est que le message.
 */
export function DemoGuard({ signupUrl }: { signupUrl: string | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      const f = e.target as HTMLFormElement | null;
      // attribut explicite uniquement : la propriété .method vaut « get » par défaut, y compris pour un formulaire relié à une action serveur
      if ((f?.getAttribute?.("method") ?? "").toLowerCase() === "get") return;
      e.preventDefault(); e.stopImmediatePropagation();
      setShown(true);
    };
    // sur window, en capture : React écoute déjà sur document et traiterait l'envoi avant nous
    window.addEventListener("submit", on, true);
    return () => window.removeEventListener("submit", on, true);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 6000);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="demo-toast" role="status">
      <span>{DEMO_READONLY_MESSAGE}</span>
      {signupUrl && <a className="btn btn-primary btn-sm" href={signupUrl}>Créer mon compte</a>}
    </div>
  );
}

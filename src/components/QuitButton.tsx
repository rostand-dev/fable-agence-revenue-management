"use client";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/**
 * « Enregistrer et quitter » de l'en-tête du parcours : soumet le formulaire `funnel-form` de l'étape avec intent=quit.
 * Désactivé pendant tout envoi de ce formulaire (attribut `data-pending`), pour éviter un double envoi :
 * un double clic sur l'étape 1 créerait deux logements.
 */
export function QuitButton() {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // le formulaire change à chaque étape : on suit toujours celui qui est affiché
    const sync = () => setBusy(!!document.getElementById("funnel-form")?.hasAttribute("data-pending"));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-pending"] });
    return () => mo.disconnect();
  }, []);

  // Bouton simple (pas « submit ») : placé avant le formulaire dans la page, un bouton d'envoi deviendrait le bouton
  // par défaut, et la touche Entrée enregistrerait et quitterait au lieu de continuer.
  const quit = () => {
    const form = document.getElementById("funnel-form") as HTMLFormElement | null;
    if (!form || form.hasAttribute("data-pending")) return;
    const intent = document.createElement("input");
    Object.assign(intent, { type: "hidden", name: "intent", value: "quit" });
    const noValidate = form.noValidate;
    form.noValidate = true; // enregistrer pour plus tard n'exige aucun champ
    form.appendChild(intent);
    try { form.requestSubmit(); } finally { intent.remove(); form.noValidate = noValidate; }
  };

  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={quit}>
      <Icon name={busy ? "spin" : "clock"} />{busy ? "Enregistrement…" : "Enregistrer et quitter"}
    </button>
  );
}

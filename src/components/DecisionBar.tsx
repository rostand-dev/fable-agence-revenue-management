"use client";
import { useEffect, useRef, useState } from "react";
import { approveAction, deferAction, rejectAction, reopenAction } from "@/app/actions/decisions";
import { ActionForm, Submit } from "./forms";

/** Barre fixée en bas de l'écran. Sa hauteur réelle est publiée (`--pk-bar-h`) : le contenu et les messages lui laissent la place. */
function Bar({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const root = document.documentElement;
    const sync = () => root.style.setProperty("--pk-bar-h", `${el.offsetHeight}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--pk-bar-h"); };
  }, []);
  return (
    <div className="pk-bar" role="group" aria-label="Décision" data-testid="barre-decision" ref={box}>
      <div className="pk-bar-inner">{children}</div>
    </div>
  );
}

/**
 * Différer, Rejeter, Approuver. `minComment` : longueur exigée par le serveur quand l'option demande un commentaire (null : aucun champ).
 * Le champ sert à l'approbation ; son contenu accompagne aussi un rejet, facultatif. Le bouton désactivé n'est qu'une aide : le serveur refuse de lui-même.
 */
export function DecisionBar({ opportunityId, candidate, canApprove, canDefer, approveText, minComment }: { opportunityId: string; candidate: number; canApprove: boolean; canDefer: boolean; approveText: string; minComment: number | null }) {
  const [comment, setComment] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  // réseau lent : un texte saisi avant l'activation de la page est déjà dans le champ, l'état le reprend
  useEffect(() => { if (field.current?.value) setComment(field.current.value); }, []);
  const missing = minComment !== null && comment.trim().length < minComment;
  const sent = minComment === null ? "" : comment;
  return (
    <Bar>
      {minComment !== null && (
        <div className="pk-bar-comment">
          <label htmlFor="pk-comment">Commentaire obligatoire <span id="pk-comment-help">· {minComment} caractères au moins</span></label>
          <textarea ref={field} id="pk-comment" rows={2} maxLength={500} required value={comment} onChange={(e) => setComment(e.target.value)}
            aria-describedby="pk-comment-help pk-comment-why" placeholder="Pourquoi vous approuvez ou rejetez cette option" />
        </div>
      )}
      <div className="pk-bar-actions">
        {canDefer && (
          <ActionForm action={deferAction} hidden={{ opportunityId }}>
            <Submit className="btn btn-ghost pk-bar-defer" icon="clock" ariaLabel="Différer de 3 jours" pendingLabel="">{null}</Submit>
          </ActionForm>
        )}
        <ActionForm action={rejectAction} hidden={{ opportunityId, comment: sent }}>
          <Submit className="btn btn-ghost" ariaLabel="Rejeter la proposition">Rejeter</Submit>
        </ActionForm>
        <ActionForm action={approveAction} hidden={{ opportunityId, candidate, comment: sent }}>
          <Submit className="btn btn-primary pk-bar-approve" disabled={!canApprove || missing} describedBy={!canApprove ? "pk-rejected" : missing ? "pk-comment-help" : undefined}>{approveText}</Submit>
        </ActionForm>
      </div>
    </Bar>
  );
}

/** Dossier tranché sans action, ou différé : un seul geste. */
export function ReopenBar({ opportunityId }: { opportunityId: string }) {
  return (
    <Bar>
      <div className="pk-bar-actions">
        <ActionForm action={reopenAction} hidden={{ opportunityId }}><Submit className="btn btn-ghost" icon="undo">Rouvrir le dossier</Submit></ActionForm>
      </div>
    </Bar>
  );
}

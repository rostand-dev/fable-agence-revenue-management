"use client";
import { createContext, useContext } from "react";
import { can, denyMessage, type Permission, type Role } from "@/lib/rbac";
import { Icon } from "./Icon";

/**
 * Droits de la personne connectée, côté écran : champs verrouillés et explication. Simple confort de lecture —
 * le serveur contrôle chaque écriture (lib/rights.ts), que l'écran la propose ou non.
 */
const RoleContext = createContext<Role | null>(null);
export function RightsProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}
/** Message de refus si le rôle connecté n'a pas ce droit ; `null` sinon (ou hors de l'espace connecté). */
export function useRefusal(need?: Permission): string | null {
  const role = useContext(RoleContext);
  return need && role && !can(role, need) ? denyMessage(role, need) : null;
}
/** Contenu proposé seulement à qui a le droit (lien vers un écran de saisie, par exemple). */
export function IfRight({ need, children }: { need: Permission; children: React.ReactNode }) {
  return useRefusal(need) ? null : <>{children}</>;
}
/** À placer au-dessus de formulaires verrouillés : dit pourquoi. N'affiche rien à qui a le droit. */
export function RightsNotice({ need }: { need: Permission }) {
  const why = useRefusal(need);
  if (!why) return null;
  return (
    <div className="banner banner-tech rights-notice" role="note">
      <Icon name="shield" />
      <div><p className="banner-title">Consultation seule</p><p className="banner-body">{why}</p></div>
    </div>
  );
}

"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { createListing, createOwner, deleteListing, deleteOwner, deleteProperty, PortfolioError, renameTenant, setListingStatus, updateListing, updateOwner } from "@/lib/services/portfolio";

/** Actions du portefeuille (US-020) : propriétaires, annonces, suppression d'un logement, nom de l'espace. Règles et audit : lib/services/portfolio.ts. */
const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const owner = (fd: FormData) => ({ name: txt(fd, "name"), email: txt(fd, "email"), notes: String(fd.get("notes") ?? "") });
const listing = (fd: FormData) => ({ channel: txt(fd, "channel"), externalId: txt(fd, "externalId"), url: txt(fd, "url"), title: txt(fd, "title") });

/** Une erreur métier revient près du formulaire ; toute autre erreur est consignée et résumée sans détail technique. */
async function run(fn: () => Promise<string | void>, okMessage?: string): Promise<FormState> {
  let to: string | void;
  try { to = await fn(); } catch (e) {
    if (e instanceof PortfolioError) return { error: e.message };
    console.error("[portefeuille]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique : rien n'a été modifié." };
  }
  revalidatePath("/", "layout");
  if (to) redirect(to);
  return okMessage ? { ok: okMessage } : null;
}

export async function createOwnerAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage"); if (no) return no;
  return run(async () => { await createOwner(u, owner(fd)); }, "Propriétaire ajouté.");
}
export async function updateOwnerAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage"); if (no) return no;
  return run(async () => { await updateOwner(u, txt(fd, "ownerId"), owner(fd)); }, "Propriétaire enregistré.");
}
export async function deleteOwnerAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage"); if (no) return no;
  return run(async () => { await deleteOwner(u, txt(fd, "ownerId")); });
}

export async function saveListingAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  const propertyId = txt(fd, "propertyId"), id = txt(fd, "listingId");
  return run(async () => { if (id) await updateListing(u, propertyId, id, listing(fd)); else await createListing(u, propertyId, listing(fd)); }, id ? "Annonce enregistrée." : "Annonce ajoutée.");
}
export async function setListingStatusAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  const status = txt(fd, "status");
  if (status !== "ACTIVE" && status !== "ARCHIVED") return { error: "Statut inconnu." };
  return run(async () => { await setListingStatus(u, txt(fd, "propertyId"), txt(fd, "listingId"), status); });
}
export async function deleteListingAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", fd.get("propertyId")); if (no) return no;
  return run(async () => { await deleteListing(u, txt(fd, "propertyId"), txt(fd, "listingId")); });
}

/** Suppression d'un logement : le nom est ressaisi pour confirmer. Retour à la liste des logements. */
export async function deletePropertyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  return run(async () => { await deleteProperty(u, txt(fd, "propertyId"), txt(fd, "confirmName")); return "/logements?supprime=1"; });
}

export async function renameTenantAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  return run(async () => { await renameTenant(u, txt(fd, "tenantName")); }, "Nom de l'espace enregistré.");
}

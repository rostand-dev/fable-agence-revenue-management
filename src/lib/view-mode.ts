/**
 * Mode d'affichage : « poche » (version allégée pour téléphone) ou « complet ».
 * Le choix vient du cookie `ns_vue` ; sans lui, de l'appareil. Les tablettes sont en version complète.
 * Fonctions pures (testées dans view-mode.test.ts), plus la lecture côté serveur pour la page demandée.
 */
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { deskScreen, PATH_HEADER, type DeskScreen } from "./nav";

export type ViewMode = "poche" | "complet";
/** Cookie du mode choisi (un an). */
export const VIEW_COOKIE = "ns_vue";
/** Cookie de session : écrans réservés à l'ordinateur pour lesquels « Afficher quand même » a été choisi. */
export const FORCE_COOKIE = "ns_vue_force";
/** Au-delà, les choix les plus anciens sont oubliés : un cookie reste petit. */
export const FORCE_MAX_KEYS = 30;
export const FORCE_MAX_LENGTH = 2000;

type HeaderReader = { get(name: string): string | null };

export const isViewMode = (v: unknown): v is ViewMode => v === "poche" || v === "complet";

/** Téléphone : l'indice client `Sec-CH-UA-Mobile` fait foi quand il est envoyé, sinon le User-Agent (iPhone, ou Android avec « Mobile »). */
export function isPhone(h: HeaderReader): boolean {
  const hint = h.get("sec-ch-ua-mobile")?.trim();
  if (hint === "?1") return true;
  if (hint === "?0") return false;
  const ua = h.get("user-agent") ?? "";
  // l'iPad écrit lui aussi « Mobile » dans son User-Agent : il est écarté avant tout
  if (/iPad/.test(ua)) return false;
  return /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /\bMobile\b/.test(ua));
}

export const viewMode = (cookie: string | null | undefined, h: HeaderReader): ViewMode => (isViewMode(cookie) ? cookie : isPhone(h) ? "poche" : "complet");

export const parseForced = (cookie: string | null | undefined): string[] => (cookie ?? "").slice(0, FORCE_MAX_LENGTH).split(",").filter(Boolean);

/** Ajoute un choix (le plus récent en dernier) sans dépasser les limites du cookie. */
export function addForced(cookie: string | null | undefined, key: string): string {
  const keys = [...parseForced(cookie).filter((k) => k !== key), key].slice(-FORCE_MAX_KEYS);
  while (keys.length > 1 && keys.join(",").length > FORCE_MAX_LENGTH) keys.shift();
  return keys.join(",");
}

const INTERNAL = "http://interne.invalid";
/** Adresse de retour : uniquement un chemin de l'application (jamais un autre site, ni la route de bascule). Sinon l'accueil. */
export function safeReturnPath(raw: string | null | undefined): string {
  // les barres obliques inversées et les caractères de contrôle sont réinterprétés par les navigateurs : refusés
  if (!raw || raw.length > 2000 || !raw.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  let u: URL;
  try { u = new URL(raw, INTERNAL); } catch { return "/"; }
  // la normalisation peut produire « //autre-site » (ex. « /..//autre-site ») : contrôlé après coup
  if (u.origin !== INTERNAL || u.pathname.startsWith("//") || /^\/vue\/?$/.test(u.pathname)) return "/";
  u.searchParams.delete("_rsc");
  return u.pathname + u.search + u.hash;
}

export type ViewContext = {
  mode: ViewMode;
  phone: boolean;
  /** chemin et paramètres de la page affichée, pour y revenir après une bascule */
  current: string;
  /** chemin seul */
  pathname: string;
  /** écran réservé à l'ordinateur à remplacer par l'encart ; null : la page s'affiche normalement */
  blocked: DeskScreen | null;
};

export function viewContext(h: HeaderReader, cookie: (name: string) => string | undefined): ViewContext {
  const mode = viewMode(cookie(VIEW_COOKIE), h);
  const asked = h.get(PATH_HEADER) ?? "/";
  // le chemin se lit à part : des paramètres refusés comme adresse de retour (trop longs, « \ ») ne doivent pas faire oublier l'écran demandé
  const pathname = safeReturnPath(asked.split(/[?#]/)[0]);
  const full = safeReturnPath(asked);
  const current = full === "/" ? pathname : full;
  const desk = mode === "poche" ? deskScreen(pathname) : null;
  const blocked = desk && !parseForced(cookie(FORCE_COOKIE)).includes(desk.key) ? desk : null;
  return { mode, phone: isPhone(h), current, pathname, blocked };
}

/** Contexte d'affichage de la requête en cours (composants serveur). */
export const getViewContext = cache(async (): Promise<ViewContext> => {
  const [h, jar] = await Promise.all([headers(), cookies()]);
  return viewContext(h, (name) => jar.get(name)?.value);
});

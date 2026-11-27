import { test, type BrowserContext } from "@playwright/test";

/**
 * Les projets mobiles se présentent comme un téléphone : l'application leur sert le mode poche (voir mode-poche.spec.ts).
 * Un test qui vise un écran réservé à l'ordinateur à ces largeurs demande la version complète, comme le ferait la personne :
 * - le cookie `ns_vue=complet` sur le contexte du test (il suit les redirections, contrairement à l'en-tête ci-dessous) ;
 * - l'indice `Sec-CH-UA-Mobile: ?0` pour les contextes que le test crée lui-même (`browser.newContext`).
 * Usage : `test.use(VERSION_COMPLETE);` en tête d'un fichier (ou d'un `test.describe`) consacré à ces écrans.
 * Quand quelques tests seulement sont concernés, ils appellent `versionComplete(page.context())` : le reste du fichier
 * continue de vérifier ce qu'un téléphone reçoit par défaut.
 */
export const VERSION_COMPLETE = {
  extraHTTPHeaders: { "Sec-CH-UA-Mobile": "?0" },
  context: async ({ context, baseURL }: { context: BrowserContext; baseURL?: string }, use: (c: BrowserContext) => Promise<void>) => {
    await context.addCookies([{ name: "ns_vue", value: "complet", url: baseURL! }]);
    await use(context);
  },
};

/**
 * Version complète pour un seul test (ou un contexte créé par lui) : même cookie, posé avant d'ouvrir l'écran réservé à l'ordinateur.
 */
export async function versionComplete(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "ns_vue", value: "complet", url: test.info().project.use.baseURL! }]);
}

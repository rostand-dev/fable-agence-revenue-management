import { expect, type Page } from "@playwright/test";

/** La page ne doit jamais défiler horizontalement (tolérance d'un pixel pour les arrondis). */
export async function expectNoHorizontalOverflow(page: Page, label = page.url()) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${label} : la page défile horizontalement (${scrollWidth} px de contenu pour ${innerWidth} px d'écran)`).toBeLessThanOrEqual(innerWidth + 1);
}

/**
 * Frise du cycle (`ol.frieze`) : les libellés d'étapes ne doivent ni se chevaucher, ni être trop serrés, ni déborder de leur case.
 * minGap : écart horizontal minimal, en pixels, entre deux textes voisins sur une même ligne.
 * Les étapes passent à la ligne : seules les cases d'une même ligne sont comparées entre elles.
 */
export async function friezeViolations(page: Page, minGap = 8): Promise<string[]> {
  return page.evaluate((gap) => {
    const out: string[] = [];
    const lists = Array.from(document.querySelectorAll<HTMLElement>("ol.frieze"));
    if (lists.length === 0) return ["aucune frise (ol.frieze) sur la page"];
    const textRect = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    lists.forEach((ol, n) => {
      const items = Array.from(ol.querySelectorAll<HTMLElement>(":scope > li"));
      if (items.length < 2) out.push(`frise ${n + 1} : moins de deux étapes`);
      items.forEach((li, i) => {
        const box = li.getBoundingClientRect();
        for (const sel of [".fr-name", ".fr-state", ".fr-no"]) {
          const el = li.querySelector(sel); if (!el) continue;
          const t = textRect(el);
          if (t.left < box.left - 0.5 || t.right > box.right + 0.5) out.push(`étape ${i + 1} (${(li.querySelector(".fr-name")?.textContent ?? "").trim()}) : le texte ${sel} déborde de sa case`);
        }
        const next = items[i + 1]; if (!next) return;
        const nb = next.getBoundingClientRect();
        const sameRow = box.top < nb.bottom && nb.top < box.bottom;
        if (sameRow && box.right > nb.left + 0.5) out.push(`étapes ${i + 1} et ${i + 2} : les cases se chevauchent`);
        for (const sel of [".fr-no", ".fr-name", ".fr-state"]) {
          const a = li.querySelector(sel), b = next.querySelector(sel); if (!a || !b) continue;
          const ra = textRect(a), rb = textRect(b);
          const sameLine = ra.top < rb.bottom && rb.top < ra.bottom;
          if (sameLine && rb.left - ra.right < gap) out.push(`étapes ${i + 1} et ${i + 2} : ${sel} séparés de ${Math.round(rb.left - ra.right)} px seulement (minimum ${gap})`);
        }
      });
    });
    return out;
  }, minGap);
}

/**
 * Contenu invisible parce que coupé : sous `racine`, les éléments (ou leur texte, quand un mot long sort de sa boîte) qui dépassent à droite
 * d'un ancêtre qui ne laisse pas déborder, ou de l'écran. `expectNoHorizontalOverflow` ne voit pas ce cas : la page ne défile pas, le texte disparaît simplement.
 * Seul un tableau large (`.table-wrap`) a le droit de défiler horizontalement ; les textes réservés aux lecteurs d'écran, les bulles et les troncatures voulues (…) sont ignorés.
 */
export async function contenuCoupe(page: Page, racine: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(sel));
    if (roots.length === 0) return [`aucun élément « ${sel} » sur la page`];
    const nom = (el: Element) => el.tagName.toLowerCase() + Array.from(el.classList, (c) => `.${c}`).join("") + (el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : "");
    const largeur = document.documentElement.clientWidth;
    const out = new Set<string>();
    for (const el of roots.flatMap((r) => [r, ...Array.from(r.querySelectorAll<HTMLElement>("*"))])) {
      const box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height === 0 || el.closest(".sr-only, .term-pop") || getComputedStyle(el).textOverflow === "ellipsis") continue;
      // un mot insécable dépasse de sa boîte sans l'élargir : on mesure aussi le texte propre de l'élément
      const texte = Math.max(0, ...Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()).map((n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().right; }));
      const right = Math.max(box.right, texte);
      let cause: string | null = right > largeur + 1 ? "l'écran" : null;
      for (let a: HTMLElement | null = texte > box.right + 1 ? el : el.parentElement; a && a !== document.body; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if ((o === "auto" || o === "scroll") && a.matches(".table-wrap")) { cause = null; break; }
        if (o !== "visible" && right > a.getBoundingClientRect().right + 1) { cause = nom(a); break; }
      }
      if (cause) out.add(`${nom(el)} dépasse de ${cause}`);
    }
    return Array.from(out).slice(0, 10);
  }, racine);
}

/**
 * Colonnes écrasées : les éléments visibles désignés par `selector` plus étroits que `minimum` pixels. Un voisin qui ne passe pas à la ligne
 * (badge, valeur, signature) réduit alors le texte à quelques lettres par ligne : rien n'est coupé ni ne défile, mais ce n'est plus lisible.
 */
export async function colonnesEcrasees(page: Page, selector: string, minimum: number): Promise<string[]> {
  const els = page.locator(`${selector} >> visible=true`);
  // rien à mesurer (sélecteur périmé, section restée repliée) : le contrôle échoue au lieu de passer à vide
  if ((await els.count()) === 0) return [`aucun élément « ${selector} » visible sur la page`];
  return els.evaluateAll((list, min) => list.filter((e) => e.getBoundingClientRect().width < min)
    .map((e) => `${Math.round(e.getBoundingClientRect().width)} px au lieu de ${min} : « ${(e.textContent ?? "").trim().slice(0, 50)} »`).slice(0, 10), minimum);
}

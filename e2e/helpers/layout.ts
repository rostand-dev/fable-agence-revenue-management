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

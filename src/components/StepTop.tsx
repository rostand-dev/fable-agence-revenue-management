"use client";
import { useLayoutEffect } from "react";

/**
 * Ramène en haut de page et place le focus sur un titre à chaque changement d'étape, pour qu'on voie qu'on a avancé
 * (le lecteur d'écran annonce le titre, et au clavier on repart du haut). Ne fait rien tant que l'étape ne change pas :
 * une erreur de validation laisse donc la page là où est le message.
 */
export function moveToTop(target: Element | null) {
  const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  focusTitle(target);
}
function focusTitle(target: Element | null) {
  if (!(target instanceof HTMLElement)) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.setAttribute("data-step-focus", "");
  target.focus({ preventScroll: true });
}

/** Étapes du parcours de création : titre `h1` de l'étape. */
export function StepTop({ stepKey }: { stepKey: string }) {
  useLayoutEffect(() => {
    const h1 = () => document.querySelector("main .fn-head h1");
    moveToTop(h1());
    // la fin de la navigation peut faire retomber le focus sur la page : on le replace alors, sans jamais le reprendre à l'utilisateur
    const lost = () => !document.activeElement || document.activeElement === document.body;
    const timers = [300, 1000].map((ms) => window.setTimeout(() => { if (lost()) focusTitle(h1()); }, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [stepKey]);
  return null;
}

"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Le serveur ne reçoit pas l'ancre d'une adresse : après la redirection d'un ancien écran, c'est ici qu'on rejoint la bonne page. */
export function LegacyAnchor({ targets }: { targets: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const go = () => {
      const id = window.location.hash.slice(1);
      if (Object.hasOwn(targets, id)) router.replace(`${targets[id]}#${id}`);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [router, targets]);
  return null;
}

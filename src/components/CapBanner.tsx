import Link from "next/link";
import { Banner } from "@/components/ui";
import { capAlert } from "@/lib/llm-registry/cap-message";
import type { CapState } from "@/lib/llm-registry/cap-state";

/** Alerte de plafond mensuel : visible à partir de 80 % de dépense, et à 100 % (les agents sont alors en mode déterministe). Rien en dessous, ni sans plafond. */
export function CapBanner({ cap, link = true }: { cap: CapState; link?: boolean }) {
  const a = capAlert(cap);
  if (!a) return null;
  return (
    <div data-testid="cap-banner" data-level={a.level} style={{ margin: "0 0 16px" }}>
      <Banner role={a.level === "reached" ? "violation" : "attention"} title={a.title}>
        <p style={{ margin: 0 }}>{a.body}{link && <> <Link href="/modeles#plafond">Régler le plafond</Link></>}</p>
      </Banner>
    </div>
  );
}

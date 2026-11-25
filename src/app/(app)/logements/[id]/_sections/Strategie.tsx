import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PromotionRegistry } from "@/components/PromotionRegistry";
import { Banner, Byline, Metric, Money, Recap, Vq } from "@/components/ui";
import { CHANNEL_LABEL } from "@/lib/engine/types";
import { channelShare } from "@/lib/engine/metrics";
import { pct } from "@/lib/format";
import { can, denyMessage } from "@/lib/rbac";
import { listPromotions } from "@/lib/services/promotion-registry";
import { listListings } from "@/lib/services/portfolio";
import type { Fiche } from "./context";

/** Stratégie en vigueur. */
export function StrategieEnVigueur({ p, strat, names }: Fiche) {
  return (
        <section className="stack">
          <Recap rows={[
            ["Objectif", strat.objective ?? <Vq>non renseigné</Vq>], ["Positionnement", strat.positioning ?? p.profile?.positioning ?? <Vq>non renseigné</Vq>],
            ["Prix de base", <Money key="b" cents={strat.basePriceCents} />, true], ["Prix minimum", <Money key="m" cents={strat.minPriceCents} />, true], ["Prix maximum", <Money key="x" cents={strat.maxPriceCents} />, true],
            ["Séjour minimum", strat.minStay ? `${strat.minStay} nuits` : <Vq>inconnu</Vq>, true],
            ["Cumul de remises maximal", `${strat.maxDiscountStackPct ?? 20} %`, true], ["Variation de prix sans validation renforcée", `± ${strat.maxPriceChangePct ?? 5} %`, true],
            ["Version", `v${p.strategyVersion}`, true],
          ]} />
          {!p.isDemo && p.status !== "ONBOARDING" && <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${p.id}/strategie`}><Icon name="sliders" />Strategy Builder : brouillon, publication, historique</Link></p>}
          <Banner role="tech" title="PriceLabs reste le moteur de prix">L'agence règle les paramètres transmis à PriceLabs ; elle ne recalcule pas ses prix journaliers. Une seule hypothèse structurante est testée à la fois.</Banner>
          <p><Byline agent="pricing" names={names} what="tient cette stratégie et propose ses évolutions" /></p>
        </section>
  );
}

/** Mix de canaux et registre des promotions. */
export async function Canaux({ user, p, input, names }: Fiche) {
  const share = channelShare(input.resas);
  const [promotions, listings] = await Promise.all([listPromotions(user.tenantId, p.id), listListings(user.tenantId, p.id)]);
  return (
        <section className="stack">
          <div className="synth">{Object.entries(share).map(([c, s]) => <Metric key={c} label={`Part ${CHANNEL_LABEL[c] ?? c}`} value={pct(s)} source="Nuits vendues · historique" />)}{Object.keys(share).length === 0 && <Metric label="Mix de canaux" value={<Vq>inconnu</Vq>} source="Aucune réservation importée" />}</div>
          <PromotionRegistry propertyId={p.id} promotions={promotions} listings={listings} canManage={can(user.role, "promotion.manage")} canVerify={can(user.role, "action.verify")} manageDenied={denyMessage(user.role, "promotion.manage")} />
          <p><Byline agent="distribution" names={names} what="tient ce registre" /></p>
        </section>
  );
}

import { CapBanner } from "@/components/CapBanner";
import { LegacyAnchor } from "@/components/LegacyAnchor";
import { Page } from "@/components/Page";
import { HubCards } from "@/components/PropertyHub";
import { getLlmStatus } from "@/lib/agents/llm-config";
import { PROVIDER_KEYS } from "@/lib/agents/owner-keys";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { isLlmAdmin } from "@/lib/llm-registry/admin";
import { getSpendState } from "@/lib/llm-registry/cap-state";
import { iaHubCards } from "@/lib/llm-registry/hub";
import { pendingPriceCount } from "@/lib/llm-registry/price-validation";

export const metadata = { title: "IA & modèles" };
/** Anciennes ancres de l'écran unique « Modèles » vers la sous-page qui porte la rubrique. */
const ANCHORS: Record<string, string> = { plafond: "/modeles/budget", couts: "/modeles/budget", modeles: "/modeles/catalogue" };

export default async function IaEtModeles() {
  const user = await requireUser();
  const [llm, cap, pending] = await Promise.all([getLlmStatus(user.tenantId), getSpendState(user.tenantId), pendingPriceCount()]);
  const chosen: Record<string, string> = user.settings.agentModels ?? {};
  const cards = iaHubCards({ providers: llm.providers.length, providersTotal: PROVIDER_KEYS.length, customAgents: AGENTS.filter((a) => chosen[a.id]).length, agentsTotal: AGENTS.length, cap, pending, canDecide: isLlmAdmin(user.email) });
  return (
    <Page title="IA & modèles" sub="Les modèles de langage de l'agence" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "IA & modèles" }]}>
      <LegacyAnchor targets={ANCHORS} />
      <div className="page-head"><h1>IA &amp; modèles</h1><p>Tout ce qui concerne les modèles de langage, réuni au même endroit. La ligne « Vient de » indique où se trouvait chaque réglage : rien n'est supprimé.</p></div>
      <CapBanner cap={cap} />
      <HubCards label="Rubriques IA et modèles" cards={cards} />
    </Page>
  );
}

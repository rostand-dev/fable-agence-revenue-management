import Link from "next/link";
import { CapBanner } from "@/components/CapBanner";
import { Icon } from "@/components/Icon";
import { LlmKeyPanel } from "@/components/LlmKeyPanel";
import { Page } from "@/components/Page";
import { Banner } from "@/components/ui";
import { getLlmStatus } from "@/lib/agents/llm-config";
import { requireUser } from "@/lib/auth";
import { getCapState } from "@/lib/llm-registry/cap-state";
import { RightsNotice } from "@/components/Rights";

export const metadata = { title: "Clés fournisseurs" };
export default async function Cles({ searchParams }: { searchParams: Promise<{ llm?: string }> }) {
  const { llm } = await searchParams;
  const user = await requireUser();
  const [status, cap] = await Promise.all([getLlmStatus(user.tenantId), getCapState(user.tenantId)]);
  return (
    <Page title="Clés fournisseurs" sub="Vos clés Anthropic, OpenAI et Mistral" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "IA & modèles", href: "/modeles" }, { label: "Clés fournisseurs" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href="/modeles"><Icon name="back" />Retour à IA &amp; modèles</Link></p>
      <div className="page-head"><h1>Clés fournisseurs</h1><p>Une clé par fournisseur, saisie par vous, chiffrée et jamais réaffichée en entier.</p></div>
      <RightsNotice need="workspace.manage" />
      {llm === "supprimee" && <Banner role="sain" title="Clé supprimée" style={{ marginBottom: 18 }}>Cette clé n'est plus utilisée. Les agents passent par vos autres clés, ou en mode déterministe s'il n'y en a pas. Les modèles choisis par agent ont été réinitialisés.</Banner>}
      <CapBanner cap={cap} />
      <LlmKeyPanel status={status} />
    </Page>
  );
}

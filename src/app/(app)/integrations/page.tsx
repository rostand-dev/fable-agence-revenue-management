import { killSwitchAction } from "@/app/actions/settings";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, Recap, State, Vq } from "@/components/ui";
import { LlmKeyPanel } from "@/components/LlmKeyPanel";
import { getLlmStatus } from "@/lib/agents/llm-config";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";
import { AVAILABILITY, capabilitiesOf, KILL_SWITCH_PROVIDERS, PROVIDER_INFO, PROVIDERS, providerStatus, resolveProvider, type ProviderStatus } from "@/lib/integrations/capabilities";
import { loadProviderFacts } from "@/lib/services/capabilities";

export const metadata = { title: "Intégrations" };
const ST: Record<ProviderStatus, [string, "sain" | "tech" | "attention" | "neutre"]> = { DEMO: ["Source simulée", "tech"], CONNECTED: ["Connectée", "sain"], NOT_CONNECTED: ["Non connectée", "neutre"], DEGRADED: ["Dégradée", "attention"] };
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export default async function Integrations({ searchParams }: { searchParams: Promise<{ llm?: string }> }) {
  const { llm } = await searchParams;
  const user = await requireUser();
  const [llmStatus, facts] = await Promise.all([getLlmStatus(user.tenantId), loadProviderFacts(user.tenantId)]);
  return (
    <Page title="Intégrations" sub="Capacités réelles de chaque connexion" crumbs={[{ label: "Configuration" }, { label: "Intégrations" }]}>
      <div className="page-head">
        <h1>Ce que l'agence peut lire et écrire</h1>
        <p>Chaque capacité est affichée telle que le code la gère aujourd'hui : une capacité absente est une dépendance visible, pas un prérequis caché. Une écriture non développée est impossible, côté serveur comme dans l'interface. Dans cette version, l'agence ne modifie rien chez vos fournisseurs : toute modification passe par une procédure manuelle guidée, avec preuve.</p>
      </div>
      {llm === "supprimee" && <Banner role="sain" title="Clé supprimée" style={{ marginBottom: 18 }}>Les agents reviennent au modèle du serveur, ou au mode déterministe s'il n'y en a pas. Les modèles choisis par agent ont été réinitialisés.</Banner>}
      <Banner role="tech" title="Démonstration simulée, logements réels en lecture" style={{ marginBottom: 18 }}>Les logements de démonstration lisent des données synthétiques et simulent l'écriture PriceLabs. Vos propres logements lisent SuperHote (réservations, calendrier) et PriceLabs (prix, marché) dès que leur jeton ou leur clé API est renseigné dans leur fiche.</Banner>
      <div className="stack">
        {PROVIDERS.map((k) => {
          const info = PROVIDER_INFO[k], f = facts[k], [label, role] = ST[providerStatus(k, f)];
          const caps = resolveProvider(k, f), hasWrite = capabilitiesOf(k).some((c) => c.kind === "write");
          const linkable = k === "superhote" || k === "pricelabs";
          return (
            <article className="stratum" key={k}>
              <header><h3>{info.name}</h3><span className="metric-source">{info.role}</span><span style={{ marginLeft: "auto" }}><State role={f.killSwitch ? "attention" : role}>{f.killSwitch ? "Coupe-circuit actif" : label}</State></span></header>
              <div className="stratum-body stack">
                <Recap rows={[
                  ...caps.map((c) => {
                    const a = AVAILABILITY[c.status];
                    return [
                      c.label,
                      <>
                        <State role={c.killed ? "attention" : a.role}>{c.killed ? "Bloquée par le coupe-circuit" : a.label}</State>
                        <span className="metric-source" style={{ display: "block", marginTop: 6 }}><strong>{c.kind === "write" ? "Écriture" : "Lecture"}</strong> · {c.reason}</span>
                      </>,
                    ] as [React.ReactNode, React.ReactNode];
                  }),
                  ...(hasWrite ? [] : [["Écriture", <><State key="w" role="neutre">Aucune</State><span className="metric-source" style={{ display: "block", marginTop: 6 }}>{info.name} est utilisé en lecture seule : aucune écriture n'est prévue.</span></>] as [React.ReactNode, React.ReactNode]]),
                  ["Logements branchés", linkable
                    ? (f.realTotal ? `${f.realLinked} sur ${f.realTotal} logement${plural(f.realTotal, "", "s")} réel${plural(f.realTotal, "", "s")}${f.demoCount ? " · démonstration simulée" : ""}` : f.demoCount ? "Aucun logement réel · démonstration simulée" : "Aucun logement")
                    : "Aucun : procédure manuelle uniquement"],
                  ["Dernière synchronisation", f.lastSyncAt ? fmtDateTime(f.lastSyncAt) : <Vq>aucune</Vq>, true], ["Suite", info.next],
                ]} />
                {KILL_SWITCH_PROVIDERS.includes(k) && (
                <ActionForm action={killSwitchAction} hidden={{ provider: k, on: f.killSwitch ? "0" : "1" }}>
                  <Submit className={f.killSwitch ? "btn btn-ghost btn-sm" : "btn btn-danger btn-sm"} icon={f.killSwitch ? "check" : "ban"}>{f.killSwitch ? "Lever le coupe-circuit" : "Activer le coupe-circuit"}</Submit>
                  <span className="metric-source" style={{ marginLeft: 10 }}>Bloque l'écriture automatique par API vers {info.name}, immédiatement. Les procédures manuelles restent possibles.</span>
                </ActionForm>
                )}
              </div>
            </article>
          );
        })}
        <LlmKeyPanel status={llmStatus} />
      </div>
    </Page>
  );
}

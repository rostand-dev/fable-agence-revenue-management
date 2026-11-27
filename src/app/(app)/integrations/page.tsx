import { killSwitchAction } from "@/app/actions/settings";
import { ActionForm, Submit } from "@/components/forms";
import { LegacyAnchor } from "@/components/LegacyAnchor";
import { Page } from "@/components/Page";
import { Banner, Recap, State, Vq } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";
import { AVAILABILITY, capabilitiesOf, KILL_SWITCH_PROVIDERS, PROVIDER_INFO, PROVIDERS, providerStatus, resolveProvider, type ProviderStatus } from "@/lib/integrations/capabilities";
import { loadProviderFacts } from "@/lib/services/capabilities";
import { ingestionErrorCount } from "@/lib/services/ingestion-errors";
import Link from "next/link";
import { RightsNotice } from "@/components/Rights";

export const metadata = { title: "Intégrations" };
const ST: Record<ProviderStatus, [string, "sain" | "tech" | "attention" | "neutre"]> = { DEMO: ["Source simulée", "tech"], CONNECTED: ["Connectée", "sain"], NOT_CONNECTED: ["Non connectée", "neutre"], DEGRADED: ["Dégradée", "attention"] };
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Les clés des modèles ont rejoint « IA & modèles » : les anciens liens y mènent. */
const MOVED: Record<string, string> = { "llm-keys": "/modeles/cles" };

export default async function Integrations() {
  const user = await requireUser();
  const [facts, ingestErrors] = await Promise.all([loadProviderFacts(user.tenantId), ingestionErrorCount(user.tenantId)]);
  // un seul formulaire pour la version complète et pour le mode poche : même action, mêmes droits
  const killSwitch = (k: (typeof PROVIDERS)[number]) => {
    const on = facts[k].killSwitch;
    return (
      <ActionForm need="property.manage" action={killSwitchAction} hidden={{ provider: k, on: on ? "0" : "1" }}>
        <Submit className={on ? "btn btn-ghost btn-sm" : "btn btn-danger btn-sm"} icon={on ? "check" : "ban"}>{on ? "Lever le coupe-circuit" : "Activer le coupe-circuit"}</Submit>
        <span className="metric-source" style={{ marginLeft: 10 }}>Bloque l'écriture automatique par API vers {PROVIDER_INFO[k].name}, immédiatement. Les procédures manuelles restent possibles.</span>
      </ActionForm>
    );
  };
  /* mode poche : le coupe-circuit, frein d'urgence, reste utilisable au-dessus de l'encart */
  const essential = (
    <section className="pk-essential" aria-labelledby="pk-kill-title" data-testid="coupe-circuit-poche">
      <h1 id="pk-kill-title">Coupe-circuit des écritures</h1>
      <RightsNotice need="property.manage" />
      {KILL_SWITCH_PROVIDERS.map((k) => (
        <article className="pk-card" key={k}>
          <header><h2>{PROVIDER_INFO[k].name}</h2><State role={facts[k].killSwitch ? "attention" : "sain"}>{facts[k].killSwitch ? "Coupe-circuit actif" : "Coupe-circuit levé"}</State></header>
          {killSwitch(k)}
        </article>
      ))}
    </section>
  );
  return (
    <Page title="Intégrations" sub="Capacités réelles de chaque connexion" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "Intégrations" }]} essential={essential}>
      <LegacyAnchor targets={MOVED} />
      <div className="page-head">
        <h1>Ce que l'agence peut lire et écrire</h1>
        <p>Chaque capacité est affichée telle que le code la gère aujourd'hui : une capacité absente est une dépendance visible, pas un prérequis caché. Une écriture non développée est impossible, côté serveur comme dans l'interface. L'écriture chez PriceLabs n'existe que pour les logements réels, une fois ouverte par l'hébergeur de l'application (verrou d'environnement) et tant que le coupe-circuit est levé ; sinon, toute modification passe par une procédure manuelle guidée, avec preuve.</p>
      </div>
      <RightsNotice need="property.manage" />
      <Banner role="tech" title="Démonstration simulée, logements réels en lecture (écriture PriceLabs verrouillée par défaut)" style={{ marginBottom: 18 }}>Les logements de démonstration lisent des données synthétiques et simulent l'écriture PriceLabs. Vos propres logements lisent SuperHote (réservations, calendrier) et PriceLabs (prix, marché) dès que leur jeton ou leur clé API est renseigné dans leur fiche.</Banner>
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
                {k === "superhote" && (
                  <div className="btn-row" data-testid="ingestion-link" style={{ alignItems: "center" }}>
                    <Link className="btn btn-ghost btn-sm" href="/integrations/erreurs">Erreurs d'ingestion</Link>
                    {ingestErrors > 0 ? <State role="attention">{ingestErrors} à traiter</State> : <State role="neutre">Aucune en attente</State>}
                  </div>
                )}
                {KILL_SWITCH_PROVIDERS.includes(k) && killSwitch(k)}
              </div>
            </article>
          );
        })}
      </div>
    </Page>
  );
}

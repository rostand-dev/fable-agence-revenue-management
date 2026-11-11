import { eq } from "drizzle-orm";
import { killSwitchAction } from "@/app/actions/settings";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, Recap, State, Vq } from "@/components/ui";
import { db, schema } from "@/db";
import { llmEnabled, llmModel } from "@/lib/agents/llm";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";

export const metadata = { title: "Intégrations" };
const INFO: Record<string, { name: string; role: string; next: string }> = {
  superhote: { name: "SuperHote", role: "PMS et channel manager · source des réservations", next: "Connexion réelle : webhooks via Make (création, modification) et rapprochement planifié. Adaptateur prévu, non branché dans cette version." },
  pricelabs: { name: "PriceLabs", role: "Moteur de prix · grille, réglages et marché", next: "Connexion réelle : clé de l'API client PriceLabs. Lecture d'abord ; l'écriture ne s'active qu'après la période d'observation." },
  booking: { name: "Booking.com", role: "Canal · promotions et commissions", next: "L'API Promotions exige un accès Connectivity Partner. D'ici là : procédure manuelle guidée, avec preuve." },
  airbnb: { name: "Airbnb", role: "Canal · promotions et commissions", next: "Aucune automatisation de navigateur : les conditions d'Airbnb l'interdisent. Procédure manuelle guidée, avec preuve." },
};
const ST: Record<string, [string, "sain" | "tech" | "attention" | "neutre"]> = { DEMO: ["Source simulée", "tech"], CONNECTED: ["Connectée", "sain"], NOT_CONNECTED: ["Non connectée", "neutre"], DEGRADED: ["Dégradée", "attention"] };
const CAP: Record<string, string> = { "pricelabs.read": "Lecture de la grille et du marché", "pricelabs.write": "Écriture après approbation", "superhote.webhooks": "Réception des réservations", "superhote.reconcile": "Rapprochement planifié", "booking.promotions.read": "Lecture des promotions", "booking.promotions.write": "Écriture des promotions", "airbnb.promotions.read": "Lecture des promotions", "airbnb.promotions.write": "Écriture des promotions" };

export default async function Integrations() {
  const user = await requireUser();
  const ints = await db.select().from(schema.integrations).where(eq(schema.integrations.tenantId, user.tenantId));
  return (
    <Page title="Intégrations" sub="Capacités réelles de chaque connexion" crumbs={[{ label: "Configuration" }, { label: "Intégrations" }]}>
      <div className="page-head">
        <h1>Ce que l'agence peut lire et écrire</h1>
        <p>Chaque capacité est affichée telle qu'elle est : une capacité absente est une dépendance visible, pas un prérequis caché. Une action n'est proposable en exécution que si la capacité, la permission et les garde-fous sont réunis.</p>
      </div>
      <Banner role="tech" title="Version actuelle : sources simulées" style={{ marginBottom: 18 }}>Les logements de démonstration lisent des données synthétiques. Les adaptateurs SuperHote et PriceLabs réels sont la prochaine étape ; vos propres logements restent en attente de données d'ici là.</Banner>
      <div className="stack">
        {["superhote", "pricelabs", "booking", "airbnb"].map((k) => {
          const i = ints.find((x) => x.provider === k), info = INFO[k], [label, role] = ST[i?.status ?? "NOT_CONNECTED"];
          return (
            <article className="stratum" key={k}>
              <header><h3>{info.name}</h3><span className="metric-source">{info.role}</span><span style={{ marginLeft: "auto" }}><State role={i?.killSwitch ? "attention" : role}>{i?.killSwitch ? "Coupe-circuit actif" : label}</State></span></header>
              <div className="stratum-body stack">
                <Recap rows={[
                  ...Object.entries(i?.capabilities ?? {}).map(([c, on]) => [CAP[c] ?? c, on ? <State key={c} role="sain">disponible{i?.status === "DEMO" ? " · simulée" : ""}</State> : <State key={c} role="neutre">non obtenue</State>] as [string, React.ReactNode]),
                  ["Dernière synchronisation", i?.lastSyncAt ? fmtDateTime(i.lastSyncAt) : <Vq>aucune</Vq>, true], ["Suite", info.next],
                ]} />
                {i && (
                  <ActionForm action={killSwitchAction} hidden={{ provider: k, on: i.killSwitch ? "0" : "1" }}>
                    <Submit className={i.killSwitch ? "btn btn-ghost btn-sm" : "btn btn-danger btn-sm"} icon={i.killSwitch ? "check" : "ban"}>{i.killSwitch ? "Lever le coupe-circuit" : "Activer le coupe-circuit"}</Submit>
                    <span className="metric-source" style={{ marginLeft: 10 }}>Bloque toute exécution vers {info.name}, immédiatement.</span>
                  </ActionForm>
                )}
              </div>
            </article>
          );
        })}
        <article className="stratum">
          <header><h3>Modèle de langage</h3><span className="metric-source">Synthèses et conversations</span><span style={{ marginLeft: "auto" }}><State role={llmEnabled() ? "sain" : "neutre"}>{llmEnabled() ? "Configuré" : "Non configuré"}</State></span></header>
          <div className="stratum-body"><Recap rows={[["Fournisseur", "Anthropic"], ["Modèle", llmEnabled() ? llmModel() : <Vq>aucun</Vq>, true], ["Sans clé", "Repli déterministe : la revue, les calculs et les garde-fous fonctionnent à l'identique."], ["Activation", "Variable d'environnement ANTHROPIC_API_KEY sur le serveur ; jamais exposée au navigateur."]]} /></div>
        </article>
      </div>
    </Page>
  );
}

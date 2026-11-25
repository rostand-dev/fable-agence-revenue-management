import Link from "next/link";
import { benchModelAction, decidePriceAction, saveMonthlyCapAction } from "@/app/actions/llm";
import { CapBanner } from "@/components/CapBanner";
import { fmtEur } from "@/lib/llm-registry/cap-message";
import { ActionForm, Submit } from "@/components/forms";
import { Page } from "@/components/Page";
import { Banner, Recap, State, Vq } from "@/components/ui";
import { PROVIDER_LABEL } from "@/lib/agents/owner-keys";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";
import { BENCH_HOURLY_LIMIT, BENCH_MODEL_COOLDOWN_MIN, QUALIFY_THRESHOLD } from "@/lib/llm-registry/bench";
import { getCapState, usdToEur } from "@/lib/llm-registry/cap-state";
import { usdEurRate } from "@/lib/llm-registry/config";
import { agentCosts, modelsOverview, MODEL_STATE_LABEL, TREND_LABEL, type ModelRow, type ModelState } from "@/lib/llm-registry/overview";
import type { PriceEntry } from "@/lib/llm-registry/prices";

export const metadata = { title: "Modèles de langage" };

const ROLE: Record<ModelState, "sain" | "tech" | "attention" | "neutre"> = { qualifie: "sain", disponible: "tech", prix_a_verifier: "attention", deprecie: "attention", indisponible: "neutre" };
const ORDER: ModelState[] = ["prix_a_verifier", "qualifie", "disponible", "indisponible", "deprecie"];
const TIER = { eco: "Économique", intermediaire: "Intermédiaire", premium: "Premium" } as const;
const usd = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);
const price = (p: PriceEntry) => `${usd(p.inputPerMtok)} entrée · ${usd(p.outputPerMtok)} sortie`;

function ModelCard({ r }: { r: ModelRow }) {
  const m = r.model, bench = r.benchEstimateUsd;
  return (
    <article className="stratum" data-testid={`model-${m.modelId}`} data-state={r.state}>
      <header>
        <h3>{m.label}</h3><span className="metric-source">{PROVIDER_LABEL[m.provider]} · {TIER[m.tier]}</span>
        <span style={{ marginLeft: "auto" }}><State role={ROLE[r.state]}>{MODEL_STATE_LABEL[r.state]}</State></span>
      </header>
      <div className="stratum-body">
        <Recap rows={[
          ["Identifiant", m.modelId, true],
          ["Votre clé", r.hasKey ? (r.available ? "Le modèle figure dans la liste" : <Vq>absent de la liste de votre clé</Vq>) : <Vq>pas de clé {PROVIDER_LABEL[m.provider]}</Vq>],
          ["Cycle de vie", r.lifecycle === "UNKNOWN" ? <Vq>pas encore relevé</Vq> : r.lifecycle === "ACTIVE" ? "Actif" : r.lifecycle === "DEPRECATED" ? `Déprécié${r.retiresAt ? ` · retrait le ${fmtDateTime(r.retiresAt)}` : ""}` : r.lifecycle === "RETIRED" ? "Retiré" : "Plus listé par le fournisseur"],
          ["Qualification", r.tasksTotal === 0 ? <Vq kind="nonchiffrable">aucune tâche concernée</Vq> : `${r.tasksQualified} tâche${r.tasksQualified > 1 ? "s" : ""} qualifiée${r.tasksQualified > 1 ? "s" : ""} sur ${r.tasksTotal}${r.tasksSuspended ? ` · ${r.tasksSuspended} suspendue${r.tasksSuspended > 1 ? "s" : ""}` : ""}`],
          ["Dernière évaluation", r.evaluatedAt ? fmtDateTime(r.evaluatedAt) : <Vq>jamais évalué</Vq>],
          ["Prix validé ($ par million de jetons)", r.price ? price(r.price) : <Vq>inconnu : le modèle n'est pas routé</Vq>],
        ]} />
        {r.pending && (
          <div data-testid="price-pending">
            <Banner role="attention" title="Nouveau prix détecté : à valider">
              <p style={{ margin: "0 0 10px" }}>{r.price ? <>Le prix passerait de <strong>{price(r.price)}</strong> à <strong>{price(r.pending)}</strong>.</> : <>Premier prix relevé : <strong>{price(r.pending)}</strong>.</>} Tant qu'il n'est pas validé, il ne sert à aucun calcul de coût ni de plafond.</p>
              <ActionForm action={decidePriceAction} hidden={{ modelId: m.modelId }}>
                <div className="btn-row">
                  <Submit name="decision" value="valider" icon="check" pendingLabel="Validation…">Valider le nouveau prix</Submit>
                  <Submit name="decision" value="refuser" className="btn btn-ghost" icon="cross" pendingLabel="Refus…">Refuser</Submit>
                </div>
              </ActionForm>
            </Banner>
          </div>
        )}
        {r.hasKey && r.available && r.tasksTotal > 0 && (
          <ActionForm action={benchModelAction} hidden={{ modelId: m.modelId }}>
            <p className="muted" style={{ margin: "0 0 10px" }}>
              Le test appelle ce modèle avec <strong>votre clé</strong> sur des cas synthétiques (aucune donnée de logement n'est envoyée) : {r.benchCalls} appel{r.benchCalls > 1 ? "s" : ""}, seuil de qualification {Math.round(QUALIFY_THRESHOLD * 100)} %.{" "}
              {bench === null ? <strong>Coût non chiffrable : le prix est inconnu, le test est refusé.</strong> : <>Coût estimé : <strong data-testid="bench-estimate">≈ {fmtEur(usdToEur(bench))}</strong>, compté dans votre plafond.</>}
            </p>
            <Submit className="btn" icon="signal" pendingLabel="Test en cours (quelques minutes)…">Tester ce modèle</Submit>
          </ActionForm>
        )}
      </div>
    </article>
  );
}

export default async function Modeles() {
  const user = await requireUser();
  const [cap, rows, costs] = await Promise.all([getCapState(user.tenantId), modelsOverview(user.tenantId), agentCosts(user.tenantId)]);
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  const count = (s: ModelState) => rows.filter((r) => r.state === s).length;
  const rate = usdEurRate();
  const total = costs.reduce((a, c) => a + c.currentEur, 0);
  return (
    <Page title="Modèles de langage" sub="Disponibilité, prix, qualification et coûts" crumbs={[{ label: "Configuration" }, { label: "Modèles" }]}>
      <div className="page-head"><h1>Modèles de langage</h1><p>Le routeur choisit, parmi vos fournisseurs, le modèle le moins cher qui convient à chaque tâche. Chaque agent peut aussi être réglé à la main dans sa fiche : un choix manuel prime toujours.</p></div>
      <CapBanner cap={cap} link={false} />

      <section className="section" id="plafond" style={{ marginTop: 0 }}>
        <h2>Plafond mensuel de dépense</h2>
        <p className="section-note">À 80 % une alerte s'affiche, à 100 % les agents repassent en mode déterministe jusqu'au 1er du mois suivant (UTC). La dépense est comptée en dollars au prix validé de chaque modèle, puis convertie au taux ci-dessous. Un appel dont le prix est inconnu n'est pas chiffré.</p>
        <Recap rows={[
          ["Dépensé ce mois-ci", `${fmtEur(cap.spentEur)}${cap.capEur === null ? "" : ` sur ${fmtEur(cap.capEur)} (${Math.round((cap.ratio ?? 0) * 100)} %)`}`, true],
          ["Taux appliqué", `1 $ = ${rate.toLocaleString("fr-FR", { maximumFractionDigits: 4 })} € (variable d'environnement LLM_USD_EUR_RATE)`, true],
        ]} />
        <ActionForm action={saveMonthlyCapAction} style={{ marginTop: 16, maxWidth: 420 }}>
          <div className="field">
            <label htmlFor="cap">Plafond mensuel (€)</label>
            <input id="cap" name="cap" type="text" inputMode="decimal" autoComplete="off" defaultValue={cap.capEur === null ? "" : String(cap.capEur).replace(".", ",")} placeholder="Aucun plafond" />
            <span className="help">Laissez vide pour ne fixer aucune limite. Montant en euros, 2 décimales au plus.</span>
          </div>
          <div style={{ marginTop: 12 }}><Submit icon="check" pendingLabel="Enregistrement…">Enregistrer le plafond</Submit></div>
        </ActionForm>
      </section>

      <section className="section" id="couts" data-testid="couts-agents">
        <h2>Coût du mois par agent</h2>
        <p className="section-note">Tendance : rythme journalier de ce mois comparé à celui du mois précédent (écart de moins de 15 % = stable). Les appels dont le prix est inconnu sont comptés à part, jamais chiffrés.</p>
        <div className="table-wrap"><table className="econ">
          <caption className="visually-hidden">Coût des modèles ce mois-ci, par agent</caption>
          <thead><tr><th scope="col">Agent</th><th scope="col">Appels</th><th scope="col">Ce mois-ci</th><th scope="col">Mois précédent</th><th scope="col">Tendance</th></tr></thead>
          <tbody>
            {costs.map((c) => (
              <tr key={c.agentId} data-agent={c.agentId}>
                <th scope="row">{c.title}</th>
                <td>{c.calls}{c.unpricedCalls ? ` (dont ${c.unpricedCalls} sans prix)` : ""}</td>
                <td>{fmtEur(c.currentEur)}</td><td>{fmtEur(c.previousEur)}</td><td>{TREND_LABEL[c.trend]}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th scope="row">Total</th><td></td><td>{fmtEur(total)}</td><td></td><td></td></tr></tfoot>
        </table></div>
      </section>

      <section className="section" id="modeles" data-testid="liste-modeles">
        <h2>Modèles du catalogue</h2>
        <p className="section-note" data-testid="modeles-synthese">
          {count("qualifie")} qualifié{count("qualifie") > 1 ? "s" : ""} · {count("disponible")} disponible{count("disponible") > 1 ? "s" : ""} · {count("prix_a_verifier")} au prix à vérifier · {count("deprecie")} déprécié{count("deprecie") > 1 ? "s" : ""} ou retiré{count("deprecie") > 1 ? "s" : ""} · {count("indisponible")} non disponible{count("indisponible") > 1 ? "s" : ""} avec vos clés.
          {" "}Le routeur n'utilise un modèle que s'il est qualifié pour la tâche, au prix validé, et présent dans la liste de votre clé. Un test coûte : au plus un par modèle toutes les {BENCH_MODEL_COOLDOWN_MIN} minutes et {BENCH_HOURLY_LIMIT} par heure.
          {" "}Les clés se saisissent dans <Link href="/integrations#llm-keys">Intégrations</Link>.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16 }}>
          {sorted.map((r) => <ModelCard key={r.model.modelId} r={r} />)}
        </div>
      </section>
    </Page>
  );
}

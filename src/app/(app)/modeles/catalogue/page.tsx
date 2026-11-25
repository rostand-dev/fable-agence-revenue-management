import Link from "next/link";
import { benchModelAction, decidePriceAction } from "@/app/actions/llm";
import { CapBanner } from "@/components/CapBanner";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Banner, Recap, State, Vq } from "@/components/ui";
import { PROVIDER_LABEL } from "@/lib/agents/owner-keys";
import { requireUser } from "@/lib/auth";
import { fmtDateTime } from "@/lib/dates";
import { isLlmAdmin } from "@/lib/llm-registry/admin";
import { BENCH_HOURLY_LIMIT, BENCH_MODEL_COOLDOWN_MIN, QUALIFY_THRESHOLD } from "@/lib/llm-registry/bench";
import { fmtEur } from "@/lib/llm-registry/cap-message";
import { getCapState, usdToEur } from "@/lib/llm-registry/cap-state";
import { modelsOverview, MODEL_STATE_LABEL, type ModelRow, type ModelState } from "@/lib/llm-registry/overview";
import type { PriceEntry } from "@/lib/llm-registry/prices";

export const metadata = { title: "Catalogue des modèles" };

const ROLE: Record<ModelState, "sain" | "tech" | "attention" | "neutre"> = { qualifie: "sain", disponible: "tech", prix_a_verifier: "attention", deprecie: "attention", indisponible: "neutre" };
const ORDER: ModelState[] = ["prix_a_verifier", "qualifie", "disponible", "indisponible", "deprecie"];
const TIER = { eco: "Économique", intermediaire: "Intermédiaire", premium: "Premium" } as const;
const usd = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);
const price = (p: PriceEntry) => `${usd(p.inputPerMtok)} entrée · ${usd(p.outputPerMtok)} sortie`;

function ModelCard({ r, admin }: { r: ModelRow; admin: boolean }) {
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
              <p style={{ margin: 0 }}>{r.price ? <>Le prix passerait de <strong>{price(r.price)}</strong> à <strong>{price(r.pending)}</strong>.</> : <>Premier prix relevé : <strong>{price(r.pending)}</strong>.</>} Tant qu'il n'est pas validé, il ne sert à aucun calcul de coût ni de plafond.</p>
            </Banner>
            {admin ? (
              <ActionForm action={decidePriceAction} hidden={{ modelId: m.modelId, snapshotId: r.pendingId ?? "" }} style={{ marginTop: 10 }}>
                <div className="btn-row">
                  <Submit name="decision" value="valider" icon="check" pendingLabel="Validation…">Valider le nouveau prix</Submit>
                  <Submit name="decision" value="refuser" className="btn btn-ghost" icon="cross" pendingLabel="Refus…">Refuser</Submit>
                </div>
              </ActionForm>
            ) : <p className="muted" style={{ margin: "10px 0 0" }}>La validation est réservée à l'exploitant de la plateforme : ce prix est partagé par tous les comptes.</p>}
          </div>
        )}
        {r.hasKey && r.available && r.tasksTotal > 0 && r.state !== "deprecie" && r.state !== "prix_a_verifier" && (
          <ActionForm action={benchModelAction} hidden={{ modelId: m.modelId }}>
            <p className="muted" style={{ margin: "0 0 10px" }}>
              Le test appelle ce modèle avec <strong>votre clé</strong> sur des cas synthétiques (aucune donnée de logement n'est envoyée) : {r.benchCalls} appel{r.benchCalls > 1 ? "s" : ""}, seuil de qualification {Math.round(QUALIFY_THRESHOLD * 100)} %.{" "}
              {bench === null ? <strong>Coût non chiffrable : le prix est inconnu, le test est refusé.</strong> : <>Coût estimé : <strong data-testid="bench-estimate">≈ {fmtEur(usdToEur(bench))}</strong> (au plus {fmtEur(usdToEur(r.benchMaxUsd ?? bench))} si des corrections sont nécessaires), compté dans votre plafond.</>}
            </p>
            {admin ? <Submit className="btn" icon="signal" pendingLabel="Test en cours (quelques minutes)…">Tester ce modèle</Submit> : <span className="muted">Le lancement d'un test est réservé à l'exploitant de la plateforme : son verdict est partagé par tous les comptes.</span>}
          </ActionForm>
        )}
      </div>
    </article>
  );
}

export default async function Catalogue({ searchParams }: { searchParams: Promise<{ prix?: string }> }) {
  const { prix } = await searchParams;
  const user = await requireUser();
  const admin = isLlmAdmin(user.email);
  const [cap, rows] = await Promise.all([getCapState(user.tenantId), modelsOverview(user.tenantId)]);
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  const count = (s: ModelState) => rows.filter((r) => r.state === s).length;
  return (
    <Page title="Catalogue des modèles" sub="Disponibilité, prix et qualification" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "IA & modèles", href: "/modeles" }, { label: "Catalogue" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href="/modeles"><Icon name="back" />Retour à IA &amp; modèles</Link></p>
      <div className="page-head"><h1>Catalogue des modèles</h1><p>Le routeur choisit, parmi vos fournisseurs, le modèle le moins cher qui convient à chaque tâche. Un choix manuel fait dans « Agents » prime toujours.</p></div>
      {(prix === "valide" || prix === "refuse") && <div data-testid="prix-decide" style={{ margin: "0 0 16px" }}><Banner role="sain" title={prix === "valide" ? "Nouveau prix validé" : "Changement de prix refusé : l'ancien prix reste en vigueur"} /></div>}
      <CapBanner cap={cap} />

      <section className="section" id="modeles" data-testid="liste-modeles" style={{ marginTop: 0 }}>
        <h2>Modèles du catalogue</h2>
        <p className="section-note" data-testid="modeles-synthese">
          {count("qualifie")} qualifié{count("qualifie") > 1 ? "s" : ""} · {count("disponible")} disponible{count("disponible") > 1 ? "s" : ""} · {count("prix_a_verifier")} au prix à vérifier · {count("deprecie")} déprécié{count("deprecie") > 1 ? "s" : ""} ou retiré{count("deprecie") > 1 ? "s" : ""} · {count("indisponible")} non disponible{count("indisponible") > 1 ? "s" : ""} avec vos clés.
          {" "}Le routeur n'utilise un modèle que s'il est qualifié pour la tâche, au prix validé, et présent dans la liste de votre clé. Un test coûte : au plus un par modèle toutes les {BENCH_MODEL_COOLDOWN_MIN} minutes et {BENCH_HOURLY_LIMIT} par heure.
          {" "}Les clés se saisissent dans <Link href="/modeles/cles">Clés fournisseurs</Link>.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16 }}>
          {sorted.map((r) => <ModelCard key={r.model.modelId} r={r} admin={admin} />)}
        </div>
      </section>
    </Page>
  );
}

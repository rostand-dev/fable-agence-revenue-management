import Link from "next/link";
import { saveMonthlyCapAction } from "@/app/actions/llm";
import { CapBanner } from "@/components/CapBanner";
import { ActionForm, Submit } from "@/components/forms";
import { Icon } from "@/components/Icon";
import { Page } from "@/components/Page";
import { Recap } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { fmtEur } from "@/lib/llm-registry/cap-message";
import { getSpendState } from "@/lib/llm-registry/cap-state";
import { usdEurRate } from "@/lib/llm-registry/config";
import { agentCosts, TREND_LABEL } from "@/lib/llm-registry/overview";

export const metadata = { title: "Budget" };
export default async function Budget() {
  const user = await requireUser();
  const [cap, costs] = await Promise.all([getSpendState(user.tenantId), agentCosts(user.tenantId)]);
  const rate = usdEurRate();
  const total = costs.reduce((a, c) => a + c.currentEur, 0);
  return (
    <Page title="Budget" sub="Plafond mensuel et coût par agent" crumbs={[{ label: "Paramètres", href: "/parametres" }, { label: "IA & modèles", href: "/modeles" }, { label: "Budget" }]}>
      <p style={{ margin: "0 0 16px" }}><Link className="btn btn-ghost btn-sm" href="/modeles"><Icon name="back" />Retour à IA &amp; modèles</Link></p>
      <div className="page-head"><h1>Budget</h1><p>La dépense du mois sur vos clés, et la limite que vous fixez.</p></div>
      <CapBanner cap={cap} link={false} />

      <section className="section" id="plafond" style={{ marginTop: 0 }}>
        <h2>Plafond mensuel de dépense</h2>
        <p className="section-note">À 80 % une alerte s'affiche, à 100 % les agents repassent en mode déterministe jusqu'au 1er du mois suivant (UTC). La dépense est comptée en dollars au prix validé de chaque modèle, puis convertie au taux ci-dessous. Un appel dont le prix est inconnu n'est pas chiffré.</p>
        <Recap rows={[
          ["Dépensé ce mois-ci", `${fmtEur(cap.spentEur)}${cap.capEur === null ? "" : ` sur ${fmtEur(cap.capEur)} (${Math.floor((cap.ratio ?? 0) * 100)} %)`}`, true],
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
          <thead><tr><th scope="col">Agent</th><th scope="col" className="num">Appels</th><th scope="col" className="num">Ce mois-ci</th><th scope="col" className="num">Mois précédent</th><th scope="col">Tendance</th></tr></thead>
          <tbody>
            {costs.map((c) => (
              <tr key={c.agentId} data-agent={c.agentId}>
                <th scope="row">{c.title}</th>
                <td className="num" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.calls}{c.unpricedCalls ? ` (dont ${c.unpricedCalls} sans prix)` : ""}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtEur(c.currentEur)}</td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtEur(c.previousEur)}</td><td>{TREND_LABEL[c.trend]}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th scope="row">Total</th><td></td><td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtEur(total)}</td><td></td><td></td></tr></tfoot>
        </table></div>
      </section>
    </Page>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import { saveCostsAction } from "@/app/actions/costs";
import { fixedMonthly, modelFromAnswers, parseNum, touristTaxPct, variablePerNight, type CostAnswers } from "@/lib/engine/costs";
import { hardFloorCents, missingEconomics, strategyFloorCents } from "@/lib/engine/economics";
import { CHANNEL_LABEL, type Channel } from "@/lib/engine/types";
import { euro } from "@/lib/format";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";

export type CostHints = {
  ines: string;
  observed: Record<string, { pct: number; n: number }>;
  nightsSold: number | null; monthsCovered: number | null; avgStay: number | null;
  minPriceCents: number | null;
};
const STEPS = ["Commissions", "Taxe de séjour", "Ménage et linge", "Coût d'une nuit", "Dérangement", "Charges fixes", "Objectif", "Résultat"];
const LAST = STEPS.length - 1;
const fr = (x: number, d = 2) => (Math.round(x * 10 ** d) / 10 ** d).toString().replace(".", ",");

/* Champs définis hors du composant : redéfinis à chaque rendu, ils feraient perdre le curseur à chaque frappe. */
type WizCtx = { a: CostAnswers; set: (k: keyof CostAnswers, v: string) => void; prov: string[]; toggle: (k: string) => void; ines: string };
const Ctx = createContext<WizCtx>(null as any);
const PROV_STYLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--quiet)", minHeight: 32, cursor: "pointer" };

function Field({ k, label, unit, help, provKey, suggest }: { k: keyof CostAnswers; label: string; unit: string; help?: string; provKey?: string; suggest?: { label: string; value: string } }) {
  const { a, set, prov, toggle } = useContext(Ctx);
  return (
    <div className="field">
      <label htmlFor={k}>{label} <span className="muted">({unit})</span></label>
      <input id={k} type="text" inputMode="decimal" value={(a[k] as string) ?? ""} onChange={(e) => set(k, e.target.value)} placeholder="je ne sais pas encore" aria-describedby={help ? k + "-h" : undefined} />
      {help && <span className="help" id={k + "-h"}>{help}</span>}
      {suggest && (a[k] ?? "") !== suggest.value && <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: "start", whiteSpace: "normal", textAlign: "left", height: "auto", padding: "8px 12px" }} onClick={() => set(k, suggest.value)}><Icon name="check" />{suggest.label}</button>}
      {provKey && <label style={PROV_STYLE}><input type="checkbox" checked={prov.includes(provKey)} onChange={() => toggle(provKey)} style={{ width: 16, height: 16, accentColor: "var(--blue-core)" }} />C'est une estimation provisoire, à confirmer</label>}
    </div>
  );
}
function Say({ children }: { children: React.ReactNode }) {
  const { ines } = useContext(Ctx);
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 18 }}>
      <Avatar agent="onboarding" size={44} />
      <div className="talk-bubble" style={{ maxWidth: "none" }}><span className="talk-who" style={{ display: "block", marginBottom: 4 }}>{ines}</span>{children}</div>
    </div>
  );
}
function Choice({ field, value, label, note }: { field: "linenMode" | "taxMode" | "nightMode"; value: string; label: string; note: string }) {
  const { a, set } = useContext(Ctx);
  const on = (a[field] ?? "") === value;
  return (
    <label className={`option${on ? " is-selected" : ""}`} style={{ cursor: "pointer", gridTemplateColumns: "auto minmax(0,1fr)", alignItems: "start", columnGap: 12 }}>
      <input type="radio" name={field} checked={on} onChange={() => set(field, value)} style={{ marginTop: 3 }} />
      <span><strong style={{ fontSize: 14.5 }}>{label}</strong><br /><span className="muted">{note}</span></span>
    </label>
  );
}

export function CostWizard({ propertyId, propertyName, initial, hints, startAt }: { propertyId: string; propertyName: string; initial: CostAnswers; hints: CostHints; startAt: number }) {
  const [a, setA] = useState<CostAnswers>({ nightMode: "calc", linenMode: "", taxMode: "calc", provisional: [], ...initial });
  const [step, setStep] = useState(startAt);
  const [msg, setMsg] = useState<{ error?: string; ok?: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const set = (k: keyof CostAnswers, v: string) => setA((s) => ({ ...s, [k]: v }));
  const prov = a.provisional ?? [];
  const toggle = (k: string) => setA((s) => ({ ...s, provisional: prov.includes(k) ? prov.filter((x) => x !== k) : [...prov, k] }));

  const model = modelFromAnswers(a);
  const miss = missingEconomics(model);
  const channels = Object.keys(model.channels) as Channel[];
  const v = variablePerNight(a), fixed = fixedMonthly(a), nightsM = parseNum(a.nightsMonth);
  const monthly = hints.nightsSold !== null && hints.monthsCovered ? Math.round(hints.nightsSold / hints.monthsCovered) : null;

  const save = (final: boolean, then?: () => void) => start(async () => {
    setMsg(null);
    const r = await saveCostsAction(propertyId, a, final);
    if (r.error) return setMsg({ error: r.error });
    if (r.done) return router.push(`/logements/${propertyId}?tab=economie`);
    if (then) then(); else setMsg({ ok: "Réponses enregistrées. Vous pouvez reprendre plus tard, à cette étape." });
  });

  const tax = touristTaxPct(a);
  return (
    <Ctx.Provider value={{ a, set, prov, toggle, ines: hints.ines }}>
    <div className="dcols">
      <div>
        <nav className="wiz-steps" aria-label="Étapes du parcours">
          <p className="wiz-here"><span className="mono">Étape {step + 1} sur {STEPS.length}</span> · <strong>{STEPS[step]}</strong></p>
          <ol>
            {STEPS.map((s, i) => (
              <li key={s}><button type="button" className={i < step ? "is-done" : i === step ? "is-here" : ""} aria-current={i === step ? "step" : undefined} aria-label={`Étape ${i + 1} : ${s}`} title={s} onClick={() => setStep(i)}>{i < step ? <Icon name="check" /> : i + 1}</button></li>
            ))}
          </ol>
        </nav>

        {step === 0 && (<>
          <Say>Commençons par ce que les plateformes prélèvent sur chaque réservation. {Object.keys(hints.observed).length ? "J'ai relevé les taux réellement appliqués sur vos réservations : reprenez-les s'ils vous semblent justes." : "Vous les trouvez sur vos relevés de versement."}</Say>
          <div className="form-grid">
            <Field k="airbnbPct" label="Commission Airbnb" unit="%" provKey="airbnbPct" help="Frais de service prélevés sur l'hôte." suggest={hints.observed.AIRBNB ? { label: `Reprendre ${fr(hints.observed.AIRBNB.pct, 1)} % — relevé sur ${hints.observed.AIRBNB.n} réservation${hints.observed.AIRBNB.n > 1 ? "s" : ""}`, value: fr(hints.observed.AIRBNB.pct, 1) } : undefined} />
            <Field k="bookingPct" label="Commission Booking.com" unit="%" provKey="bookingPct" suggest={hints.observed.BOOKING ? { label: `Reprendre ${fr(hints.observed.BOOKING.pct, 1)} % — relevé sur ${hints.observed.BOOKING.n} réservation${hints.observed.BOOKING.n > 1 ? "s" : ""}`, value: fr(hints.observed.BOOKING.pct, 1) } : undefined} />
            <Field k="bookingFeePct" label="Frais de paiement Booking.com" unit="%" help="Seulement si Booking.com encaisse pour vous. Sinon, laissez vide." />
          </div>
          {hints.observed.BOOKING && <p className="kpi-note">Le taux relevé sur Booking.com peut déjà contenir les frais de paiement : dans ce cas, laissez le champ « frais de paiement » vide.</p>}
        </>)}

        {step === 1 && (<>
          <Say>Le montant que votre logiciel de réservation me transmet est ce que paie le voyageur, taxe de séjour comprise. Or cette taxe est collectée puis reversée à la commune : ce n'est pas un revenu. Dites-moi quelle part elle représente, pour que je ne gonfle pas vos chiffres.</Say>
          <div className="options">
            <Choice field="taxMode" value="calc" label="Je la calcule avec mes statistiques" note="Dans SuperHote : Statistiques → Général, sur une année. Relevez « Taxes de séjour » et « Revenus bruts des réservations »." />
            <Choice field="taxMode" value="direct" label="Je connais le pourcentage" note="La part de la taxe dans le montant total payé par le voyageur." />
            <Choice field="taxMode" value="none" label="Aucune taxe de séjour n'est comprise dans mes montants" note="Je compte alors 0 % : c'est un zéro que vous déclarez." />
          </div>
          {a.taxMode === "calc" && <div className="form-grid" style={{ marginTop: 14 }}><Field k="taxYear" label="Taxes de séjour sur l'année" unit="€" /><Field k="grossYear" label="Revenus bruts des réservations sur la même année" unit="€" help="Le total payé par les voyageurs." /></div>}
          {a.taxMode === "direct" && <div className="form-grid" style={{ marginTop: 14 }}><Field k="taxPct" label="Part de la taxe de séjour" unit="% du montant" /></div>}
          <p className="kpi-note">{tax === null ? "Sans réponse, je ne retire rien : votre revenu net affiché restera surestimé du montant de la taxe. Cette étape n'empêche pas de calculer les planchers." : <>Part retenue : <strong style={{ color: "var(--ink)" }}>{fr(tax, 1)} %</strong> du montant de chaque réservation, retirée du revenu et de la base des commissions estimées.</>}</p>
        </>)}

        {step === 2 && (<>
          <Say>Maintenant, ce que coûte un séjour, quelle que soit sa durée : le ménage et le linge. C'est ce qui rend les séjours d'une nuit peu rentables.</Say>
          <div className="form-grid">
            <Field k="cleaningFee" label="Frais de ménage que vous facturez au voyageur" unit="€ par séjour" provKey="cleaningFee" help="Le montant affiché sur vos annonces. Écrivez 0 si vous n'en facturez pas." />
            <Field k="cleaningCost" label="Ce que le ménage vous coûte réellement" unit="€ par séjour" provKey="cleaningCost" help="La facture de votre prestataire, ou ce que vous estimez pour votre temps." />
          </div>
          <p className="gauge-label" style={{ margin: "20px 0 8px" }}>Et le linge ?</p>
          <div className="options">
            <Choice field="linenMode" value="included" label="Il est compris dans ma prestation de ménage" note="Je compte alors 0 € : c'est un zéro que vous déclarez, pas une valeur manquante." />
            <Choice field="linenMode" value="self" label="Je le lave moi-même" note="Comptez la lessive, l'eau et l'électricité d'une machine, plus un peu d'usure." />
            <Choice field="linenMode" value="service" label="Je le loue ou je le confie à un pressing" note="Reprenez le prix facturé par séjour." />
          </div>
          {(a.linenMode === "self" || a.linenMode === "service") && <div className="form-grid" style={{ marginTop: 14 }}><Field k="linenCost" label="Coût du linge" unit="€ par séjour" provKey="linenCost" /></div>}
        </>)}

        {step === 3 && (<>
          <Say>Combien vous coûte une nuit occupée de plus ? Chauffage, eau, électricité, café, savon. Je peux le calculer à partir de vos factures, ou vous pouvez me donner directement le montant.</Say>
          <div className="filters" role="group" aria-label="Mode de saisie">
            <button type="button" className="chip" aria-pressed={a.nightMode !== "direct"} onClick={() => set("nightMode", "calc")}>Calculer avec mes factures</button>
            <button type="button" className="chip" aria-pressed={a.nightMode === "direct"} onClick={() => set("nightMode", "direct")}>Je connais le montant par nuit</button>
          </div>
          {a.nightMode === "direct" ? (
            <div className="form-grid"><Field k="variableDirect" label="Coût d'une nuit occupée" unit="€ par nuit" provKey="variable" /></div>
          ) : (<>
            <div className="form-grid">
              <Field k="energyYear" label="Électricité et chauffage" unit="€ par an" help="La part liée au logement loué. Hors abonnement si vous le payez de toute façon." />
              <Field k="waterYear" label="Eau" unit="€ par an" />
              <Field k="nightsYear" label="Nuits occupées sur la même année" unit="nuits" help={hints.nightsSold !== null ? `J'ai relevé ${hints.nightsSold} nuits vendues sur ${hints.monthsCovered} mois d'historique.` : "Je n'ai pas encore d'historique pour vous le proposer."} suggest={hints.nightsSold !== null && hints.monthsCovered ? { label: `Reprendre ${Math.round(hints.nightsSold * 12 / hints.monthsCovered)} nuits (ramené à 12 mois)`, value: String(Math.round(hints.nightsSold * 12 / hints.monthsCovered)) } : undefined} />
              <Field k="consumablesStay" label="Consommables par séjour" unit="€" help="Café, thé, savon, papier, produits d'accueil." />
              <Field k="avgStay" label="Durée moyenne d'un séjour" unit="nuits" suggest={hints.avgStay ? { label: `Reprendre ${hints.avgStay} nuits — durée médiane relevée`, value: String(hints.avgStay) } : undefined} />
            </div>
            <label className="pick" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--quiet)", marginTop: 12, cursor: "pointer" }}><input type="checkbox" checked={prov.includes("variable")} onChange={() => toggle("variable")} style={{ width: 16, height: 16, accentColor: "var(--blue-core)" }} />Ces montants sont des estimations provisoires</label>
          </>)}
          <p className="kpi-note">{v === null ? "Pas encore assez d'éléments pour calculer le coût d'une nuit." : <>Coût retenu : <strong style={{ color: "var(--ink)" }}>{fr(v)} € par nuit occupée</strong>{a.nightMode !== "direct" && " — (énergie + eau) ÷ nuits occupées, plus consommables ÷ durée moyenne."}</>}</p>
        </>)}

        {step === 4 && (<>
          <Say>Il reste trois questions, une par écran. Je ne vous demande pas de « contribution par nuit » : répondez simplement, je fais la conversion. La première : votre seuil de dérangement.</Say>
          <p className="section-note" style={{ margin: "0 0 10px" }}>Une fois le ménage, la commission et les consommations payés, en dessous de combien par nuit préférez-vous laisser le logement vide ? Pensez à l'usure et au temps passé. C'est le plancher absolu : en dessous, l'auditeur oppose son veto.</p>
          <div className="form-grid"><Field k="hard" label="Seuil de dérangement" unit="€ par nuit" provKey="hard" /></div>

        </>)}

        {step === 5 && (<>
          <Say>Deuxième question : ce que le logement vous coûte chaque mois, qu'il soit loué ou non. Je répartis ce total sur vos nuits vendues pour savoir ce que chaque nuit doit rapporter au minimum pour que vous ne perdiez pas d'argent sur le mois.</Say>
          <p className="section-note" style={{ margin: "0 0 10px" }}>Ce que le logement vous coûte chaque mois, loué ou non. N'indiquez que les charges que la location doit couvrir ; laissez vide ce qui ne vous concerne pas.</p>
          <div className="form-grid">
            <Field k="rent" label="Loyer ou mensualité de crédit" unit="€ par mois" /><Field k="coop" label="Charges de copropriété" unit="€ par mois" />
            <Field k="insurance" label="Assurance" unit="€ par mois" /><Field k="subs" label="Abonnements (internet, énergie, logiciels)" unit="€ par mois" />
            <Field k="taxes" label="Taxes et impôts, ramenés au mois" unit="€ par mois" /><Field k="other" label="Autres charges fixes" unit="€ par mois" />
            <Field k="nightsMonth" label="Nuits vendues un mois ordinaire" unit="nuits" provKey="nightsMonth" help="Sert à répartir les charges fixes sur chaque nuit vendue." suggest={monthly ? { label: `Reprendre ${monthly} nuits — moyenne relevée sur ${hints.monthsCovered} mois`, value: String(monthly) } : undefined} />
          </div>
          <label className="pick" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--quiet)", marginTop: 10, cursor: "pointer" }}><input type="checkbox" checked={prov.includes("fixed")} onChange={() => toggle("fixed")} style={{ width: 16, height: 16, accentColor: "var(--blue-core)" }} />Ces charges sont des estimations provisoires</label>
          <p className="kpi-note">{fixed === null ? "Aucune charge fixe indiquée pour l'instant." : !nightsM ? `Charges fixes : ${fr(fixed)} € par mois. Indiquez vos nuits vendues pour les répartir.` : <>Charges fixes : {fr(fixed)} € par mois, soit <strong style={{ color: "var(--ink)" }}>{fr(fixed / nightsM)} € à couvrir par nuit vendue</strong>. C'est le plancher stratégique : en dessous, une validation commentée vous est demandée.</>}</p>

        </>)}

        {step === 6 && (<>
          <Say>Dernière question : ce que vous attendez du logement. Elle est facultative et ne bloque rien, mais elle donne un cap à l'équipe.</Say>
          <p className="section-note" style={{ margin: "0 0 10px" }}>Le revenu mensuel que vous visez une fois toutes les charges payées. Ce n'est pas un plancher : c'est la cible que l'équipe cherche à atteindre.</p>
          <div className="form-grid"><Field k="goalMonth" label="Revenu mensuel visé" unit="€ par mois" provKey="goalMonth" /></div>
        </>)}

        {step === LAST && (<>
          <Say>{miss.length === 0 ? `Voici ce que vos réponses donnent pour ${propertyName}. Vérifiez que ces planchers vous paraissent sensés avant de valider.` : "Il me manque encore quelques réponses pour calculer vos planchers. Une estimation provisoire suffit pour démarrer : vous la confirmerez plus tard."}</Say>
          {miss.length > 0 ? (
            <div className="banner banner-attention" role="status"><Icon name="alert" /><div><p className="banner-title">Encore {miss.length} valeur{miss.length > 1 ? "s" : ""} à renseigner</p><p className="banner-body">{miss.join(", ")}. Revenez à l'étape concernée en cliquant sur son nom dans la frise.</p></div></div>
          ) : (<>
            <div className="table-wrap"><table className="econ">
              <thead><tr><th scope="col">Canal</th><th scope="col" className="num">Séjour</th><th scope="col" className="num">Plancher absolu</th><th scope="col" className="num">Plancher stratégique</th></tr></thead>
              <tbody>{channels.flatMap((c) => [2, 7, 28].map((n) => <tr key={c + n}><th scope="row">{CHANNEL_LABEL[c]}</th><td className="num">{n} nuits</td><td className="num">{euro(hardFloorCents(model, c, n))}</td><td className="num">{euro(strategyFloorCents(model, c, n))}</td></tr>))}</tbody>
            </table></div>
            <p className="kpi-note">Prix vendu minimal par nuit, après remises de la plateforme. Il baisse quand le séjour s'allonge, car le ménage se répartit sur plus de nuits.</p>
            {prov.length > 0 && <div className="banner banner-tech" role="status" style={{ marginTop: 14 }}><Icon name="info" /><div><p className="banner-title">{model.provisional!.length} valeur{model.provisional!.length > 1 ? "s" : ""} provisoire{model.provisional!.length > 1 ? "s" : ""}</p><p className="banner-body">{model.provisional!.join(", ")}. La revue démarre quand même ; chaque dossier portera la mention « planchers provisoires » jusqu'à votre confirmation.</p></div></div>}
          </>)}
        </>)}

        {msg?.error && <div className="banner banner-attention" role="alert" style={{ marginTop: 16 }}><Icon name="alert" /><div><p className="banner-title">Je ne peux pas valider</p><p className="banner-body">{msg.error}</p></div></div>}
        {msg?.ok && <div className="banner banner-sain" role="status" style={{ marginTop: 16 }}><Icon name="check" /><div><p className="banner-title">{msg.ok}</p></div></div>}
        <div className="row-wrap" style={{ marginTop: 22 }}>
          {step > 0 && <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => setStep(step - 1)}><Icon name="back" />Précédent</button>}
          {step < LAST && <button type="button" className="btn btn-primary" disabled={pending} onClick={() => save(false, () => { setStep(step + 1); window.scrollTo({ top: 0 }); })}><Icon name={pending ? "spin" : "arrow"} />{pending ? "Enregistrement…" : "Enregistrer et continuer"}</button>}
          {step === LAST && <button type="button" className="btn btn-primary" disabled={pending || miss.length > 0} onClick={() => save(true)}><Icon name={pending ? "spin" : "check"} />{pending ? "Validation et première revue…" : "Valider mes coûts et seuils"}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => save(false)}><Icon name="clock" />Enregistrer et reprendre plus tard</button>
        </div>
      </div>

      <aside className="evidence" aria-labelledby="live-h">
        <header><h3 id="live-h">Ce que ça donne</h3><p>Mis à jour à chaque réponse.</p></header>
        <div className="evidence-body">
          {miss.length === 0 ? channels.map((c) => (
            <div className="block block-faits" key={c} style={{ marginBottom: 10 }}>
              <h3>{CHANNEL_LABEL[c]} · séjour de 2 nuits</h3>
              <dl>
                <div><dt>Jamais en dessous de</dt><dd>{euro(hardFloorCents(model, c, 2))}</dd></div>
                <div><dt>Validation commentée sous</dt><dd>{euro(strategyFloorCents(model, c, 2))}</dd></div>
              </dl>
            </div>
          )) : (
            <div className="block block-interpretations" style={{ marginBottom: 10 }}>
              <h3>Planchers pas encore calculables</h3>
              <p className="muted" style={{ margin: "6px 0 0" }}>Il manque : {miss.join(", ")}.</p>
            </div>
          )}
          {miss.length === 0 && hints.minPriceCents !== null && channels.length > 0 && (() => {
            const worst = Math.max(...channels.map((c) => hardFloorCents(model, c, 2)));
            return <div className="block block-comparaisons" style={{ marginBottom: 10 }}><h3>Face à votre prix minimum PriceLabs</h3><p className="muted" style={{ margin: "6px 0 0" }}>Votre prix minimum est de {euro(hints.minPriceCents)}. {hints.minPriceCents >= worst ? `Il reste au-dessus de votre plancher absolu le plus haut (${euro(worst)}) avant remise de plateforme.` : `Il est en dessous de votre plancher absolu le plus haut (${euro(worst)}) : PriceLabs peut publier un prix que l'auditeur refusera.`}</p></div>;
          })()}
          <div className="block" style={{ marginBottom: 0 }}>
            <h3>Vos réponses</h3>
            <dl>
              <div><dt>Coût d'un séjour non récupéré</dt><dd>{model.cleaningCostCents !== null && model.linenCostCents !== null && model.cleaningFeeChargedCents !== null ? euro(model.cleaningCostCents + model.linenCostCents - model.cleaningFeeChargedCents) + " avant commission" : "inconnu"}</dd></div>
              <div><dt>Coût d'une nuit occupée</dt><dd>{v === null ? "inconnu" : fr(v) + " €"}</dd></div>
              <div><dt>Charges fixes par nuit vendue</dt><dd>{fixed !== null && nightsM ? fr(fixed / nightsM) + " €" : "inconnu"}</dd></div>
              <div><dt>Valeurs provisoires</dt><dd>{prov.length}</dd></div>
            </dl>
          </div>
        </div>
      </aside>
    </div>
    </Ctx.Provider>
  );
}

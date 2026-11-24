import Link from "next/link";
import { declarePromotionAction, endPromotionAction, updatePromotionAction, verifyPromotionAction } from "@/app/actions/promotions";
import { ActionForm, Submit } from "@/components/forms";
import { State, Vq } from "@/components/ui";
import { fmtDay, todayISO } from "@/lib/dates";
import { cooldownFor } from "@/lib/promotions/lifecycle";
import { CHANNEL_LABEL, type Channel } from "@/lib/engine/types";
import { AUDIENCE_LABEL, PROMO_CHANNELS, VERIFY_MAX_AGE_DAYS } from "@/lib/promotions/registry";
import { kindsOf, promoKind } from "@/lib/stacking/rules";
import type { PromotionListItem } from "@/lib/services/promotion-registry";

type ListingOption = { id: string; channel: string; title: string | null; externalId: string | null; status: string };
const STATE: Record<PromotionListItem["view"]["state"], { role: "sain" | "tech" | "neutre" | "attention"; label: string }> = {
  ACTIVE: { role: "sain", label: "Active" }, PLANNED: { role: "tech", label: "Planifiée" }, EXPIRED: { role: "attention", label: "Séjours passés" }, ENDED: { role: "neutre", label: "Terminée" },
};
const fr = (d: string) => d.split("-").reverse().join("/");
const listingName = (l: ListingOption) => `${CHANNEL_LABEL[l.channel as Channel] ?? l.channel} · ${l.title || l.externalId || "annonce sans titre"}${l.status === "ARCHIVED" ? " (archivée)" : ""}`;

/** Champs communs à l'ajout et à la modification d'une promotion. Dates au format du navigateur (aaaa-mm-jj) ; champ vide = pas de valeur. */
function Fields({ idp, v, listings, withType }: { idp: string; v?: PromotionListItem; listings: ListingOption[]; withType: boolean }) {
  return (
    <div className="promo-grid">
      {withType && (
        <div className="field">
          <label htmlFor={`${idp}-type`}>Canal et type de promotion<span className="req">*</span></label>
          <select id={`${idp}-type`} name="typeKey" required defaultValue="">
            <option value="" disabled>Choisir…</option>
            {PROMO_CHANNELS.map((c) => <optgroup key={c} label={CHANNEL_LABEL[c]}>{kindsOf(c).map((k) => <option key={k.kind} value={`${c}:${k.kind}`}>{k.label}</option>)}</optgroup>)}
          </select>
        </div>
      )}
      <div className="field"><label htmlFor={`${idp}-label`}>Nom dans l'extranet</label><input id={`${idp}-label`} name="label" type="text" maxLength={120} defaultValue={v?.label ?? ""} placeholder="Facultatif : le type est repris" /></div>
      <div className="field"><label htmlFor={`${idp}-pct`}>Remise (%)<span className="req">*</span></label><input id={`${idp}-pct`} name="discountPct" type="number" inputMode="decimal" min={1} max={80} step="0.1" required defaultValue={v?.discountPct ?? ""} /></div>
      <div className="field"><label htmlFor={`${idp}-sf`}>Séjours à partir du</label><input id={`${idp}-sf`} name="stayFrom" type="date" defaultValue={v?.stayFrom ?? ""} /></div>
      <div className="field"><label htmlFor={`${idp}-st`}>Séjours jusqu'au (départ exclu)</label><input id={`${idp}-st`} name="stayTo" type="date" defaultValue={v?.stayTo ?? ""} /><span className="help">Les deux dates vides = promotion permanente.</span></div>
      <div className="field"><label htmlFor={`${idp}-bf`}>Réservable à partir du</label><input id={`${idp}-bf`} name="bookFrom" type="date" defaultValue={v?.bookFrom ?? ""} /></div>
      <div className="field"><label htmlFor={`${idp}-bt`}>Réservable jusqu'au</label><input id={`${idp}-bt`} name="bookTo" type="date" defaultValue={v?.bookTo ?? ""} /></div>
      <div className="field"><label htmlFor={`${idp}-los`}>Séjour minimal (nuits)</label><input id={`${idp}-los`} name="minLos" type="number" inputMode="numeric" min={1} max={365} step={1} defaultValue={v?.minLos ?? ""} /></div>
      <div className="field">
        <label htmlFor={`${idp}-lst`}>Annonce visée</label>
        <select id={`${idp}-lst`} name="listingId" defaultValue={v?.listingId ?? ""}>
          <option value="">Toutes les annonces du canal</option>
          {v?.listingId && !listings.some((l) => l.id === v.listingId) && <option value={v.listingId}>Annonce supprimée (à remplacer)</option>}
          {listings.filter((l) => l.status === "ACTIVE" || l.id === v?.listingId).map((l) => <option key={l.id} value={l.id}>{listingName(l)}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor={`${idp}-ref`}>Identifiant dans l'extranet</label><input id={`${idp}-ref`} name="externalRef" type="text" maxLength={120} autoComplete="off" defaultValue={v?.externalRef ?? ""} placeholder="Facultatif" /></div>
    </div>
  );
}

function Card({ p, listings, canManage, canVerify }: { p: PromotionListItem; listings: ListingOption[]; canManage: boolean; canVerify: boolean }) {
  const s = STATE[p.view.state], def = promoKind(p.channel, p.kind), live = p.view.state === "ACTIVE" || p.view.state === "PLANNED";
  const listing = p.listingId ? listings.find((l) => l.id === p.listingId) : null;
  return (
    <article className="card promo-card" data-testid="promo-card" data-state={p.view.state} data-kind={p.kind} aria-labelledby={`pr-${p.id}`}>
      <header className="alert-head">
        <State role={s.role}>{s.label}</State>
        <span className="muted">{CHANNEL_LABEL[p.channel as Channel] ?? p.channel} · {def?.label ?? p.kind}</span>
        {p.view.state === "ACTIVE" && p.view.freshness === "STALE" && <State role="attention">À re-vérifier</State>}
        {p.view.state === "ACTIVE" && p.view.freshness === "NEVER" && <State role="attention">Jamais vérifiée</State>}
      </header>
      <h3 id={`pr-${p.id}`} className="alert-title">{p.label} <span className="promo-pct">−{String(p.discountPct).replace(".", ",")} %</span></h3>
      <dl className="promo-facts">
        <div><dt>Séjours</dt><dd>{p.stayFrom && p.stayTo ? `du ${fr(p.stayFrom)} au ${fr(p.stayTo)} (départ exclu)` : "permanente"}</dd></div>
        <div><dt>Réservable</dt><dd>{p.bookFrom && p.bookTo ? `du ${fr(p.bookFrom)} au ${fr(p.bookTo)}` : "à toute date"}</dd></div>
        <div><dt>Séjour minimal</dt><dd>{p.minLos ? `${p.minLos} nuit${p.minLos > 1 ? "s" : ""}` : "aucun"}</dd></div>
        <div><dt>Audience</dt><dd>{AUDIENCE_LABEL[p.audience] ?? p.audience}</dd></div>
        <div><dt>Annonce</dt><dd>{listing ? listingName(listing) : p.listingId ? "annonce supprimée" : "toutes les annonces du canal"}</dd></div>
        {p.externalRef && <div><dt>Identifiant</dt><dd>{p.externalRef}</dd></div>}
        {p.effectiveOn && <div><dt>En vigueur depuis</dt><dd>{fr(p.effectiveOn)}</dd></div>}
        {p.proof && <div><dt>Preuve</dt><dd data-testid="promo-proof">{p.proof}</dd></div>}
        {p.actionId && <div><dt>Origine</dt><dd>Action approuvée, confirmée par l'opérateur</dd></div>}
        <div><dt>Dernière vérification</dt><dd>{p.view.state === "ENDED" ? <span className="muted">terminée{p.endedAt ? ` le ${fmtDay(p.endedAt.toISOString().slice(0, 10))}` : ""}{p.endReason ? ` — ${p.endReason}` : ""}</span>
          : p.view.ageDays === null ? <Vq>jamais</Vq> : p.view.freshness === "STALE" ? <Vq kind="obsolete">il y a {p.view.ageDays} j</Vq> : p.view.ageDays === 0 ? "aujourd'hui" : `il y a ${p.view.ageDays} j`}</dd></div>
      </dl>
      {p.unknownStackWith.length > 0 && <p className="promo-warn" role="note">Cumul inconnu avec {p.unknownStackWith.map((l) => `« ${l} »`).join(", ")} : l'aide officielle ne dit pas si ces offres se cumulent (voir « Méthode »).</p>}
      {p.view.state === "EXPIRED" && <p className="promo-warn" role="note">Les séjours visés sont passés : cette promotion sera terminée automatiquement au prochain passage du planificateur (toutes les 15 minutes) ; vous pouvez aussi la terminer maintenant.</p>}
      {p.view.state === "ENDED" && (() => {
        const rest = cooldownFor([{ channel: p.channel, kind: p.kind, listingId: p.listingId, status: p.status, endedAt: p.endedAt, endReason: p.endReason, label: p.label }], { channel: p.channel, kind: p.kind, listingId: p.listingId }, todayISO());
        return rest ? <p className="promo-warn" role="note" data-testid="promo-repos">Période de repos jusqu'au {fr(rest.until)} : pas de nouvelle promotion de ce type sur ce canal avant cette date, pour laisser lire l'effet de l'arrêt.</p> : null;
      })()}
      {(live || p.view.state === "EXPIRED") && (canManage || canVerify) && (
        <div className="promo-actions">
          {canVerify && p.view.state === "ACTIVE" && <ActionForm action={verifyPromotionAction} hidden={{ promotionId: p.id }}><Submit className="btn btn-sm" icon="check">Marquer vérifiée</Submit></ActionForm>}
          {canManage && live && (
            <details className="fold promo-fold"><summary>Modifier<span className="sr-only"> « {p.label} »</span></summary>
              <div className="fold-body"><ActionForm action={updatePromotionAction} hidden={{ promotionId: p.id }}><Fields idp={`u-${p.id}`} v={p} listings={listings} withType={false} />
                <p className="help">Une modification remet la promotion à « jamais vérifiée » : relisez-la ensuite dans l'extranet.</p>
                <div className="row-wrap" style={{ marginTop: 12 }}><Submit className="btn btn-primary btn-sm" icon="check">Enregistrer</Submit></div></ActionForm></div>
            </details>
          )}
          {canManage && (
            <details className="fold promo-fold"><summary>Terminer<span className="sr-only"> « {p.label} »</span></summary>
              <div className="fold-body"><ActionForm action={endPromotionAction} hidden={{ promotionId: p.id }}>
                <div className="field"><label htmlFor={`e-${p.id}`}>Motif (facultatif)</label><input id={`e-${p.id}`} name="reason" type="text" maxLength={200} placeholder="Arrêtée dans l'extranet, arrivée à son terme…" /></div>
                <div className="row-wrap" style={{ marginTop: 12 }}><Submit className="btn btn-danger btn-sm" icon="cross">Terminer la promotion</Submit></div></ActionForm></div>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

/** Registre des promotions d'un logement (US-100) : ce qui est réellement en ligne chez les canaux, relevé à la main dans leur extranet. */
export function PromotionRegistry({ propertyId, promotions, listings, canManage, canVerify, manageDenied }: { propertyId: string; promotions: PromotionListItem[]; listings: ListingOption[]; canManage: boolean; canVerify: boolean; manageDenied: string }) {
  const live = promotions.filter((p) => p.view.state !== "ENDED"), ended = promotions.filter((p) => p.view.state === "ENDED");
  return (
    <section className="stack" data-testid="promo-registry" aria-labelledby="promo-h">
      <h2 id="promo-h" style={{ fontSize: 18, margin: "14px 0 0" }}>Registre des promotions</h2>
      <p className="section-note" style={{ margin: 0 }}>Tenu à la main tant que les accès partenaires officiels ne sont pas obtenus : il reflète ce que vous relevez dans l'extranet d'Airbnb ou de Booking.com. Au-delà de {VERIFY_MAX_AGE_DAYS} jours sans vérification, une promotion est considérée comme incertaine.</p>
      <p style={{ margin: 0 }}><Link className="btn btn-ghost btn-sm" href={`/logements/${propertyId}/compilateur`} data-testid="open-compiler">Que proposer ? Compiler une intention</Link></p>
      {canManage ? (
        <details className="fold" data-testid="promo-add"><summary>Déclarer une promotion</summary>
          <div className="fold-body">
            <ActionForm action={declarePromotionAction} hidden={{ propertyId }} resetOnOk>
              <Fields idp="new" listings={listings} withType />
              <p className="help">La promotion est inscrite comme vérifiée à l'instant : vous venez de la lire dans l'extranet. Rien n'est écrit chez le canal.</p>
              <div className="row-wrap" style={{ marginTop: 12 }}><Submit className="btn btn-primary" icon="check">Ajouter au registre</Submit></div>
            </ActionForm>
          </div>
        </details>
      ) : <p className="muted" data-testid="promo-readonly">{manageDenied}</p>}
      {live.length === 0 ? <p className="muted">Aucune promotion en cours déclarée.</p> : <div className="alert-list" data-testid="promo-list">{live.map((p) => <Card key={p.id} p={p} listings={listings} canManage={canManage} canVerify={canVerify} />)}</div>}
      {ended.length > 0 && (
        <details className="fold"><summary>Promotions terminées ({ended.length})</summary>
          <div className="fold-body"><div className="alert-list" data-testid="promo-ended">{ended.map((p) => <Card key={p.id} p={p} listings={listings} canManage={false} canVerify={false} />)}</div></div>
        </details>
      )}
    </section>
  );
}

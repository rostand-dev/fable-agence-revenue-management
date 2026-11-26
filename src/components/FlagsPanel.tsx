import { setFlagAction } from "@/app/actions/settings";
import { ActionForm, Submit } from "@/components/forms";
import { FLAGS, resolveFlag, TENANT_SCOPE_ID, type FlagRow } from "@/lib/flags/catalog";
import { FLAG_PROVIDERS } from "@/lib/flags/catalog";
import { PROVIDER_INFO } from "@/lib/integrations/capabilities";

/** Un interrupteur : le libellé dit l'état (jamais la couleur seule), le bouton propose l'état inverse. */
function Toggle({ flag, scope, scopeId, label, on, blockedAbove }: { flag: string; scope: string; scopeId: string; label: string; on: boolean; blockedAbove?: string | null }) {
  // un niveau supérieur coupé l'emporte : on le dit, et le bouton disparaît tant qu'il n'est pas rétabli (il ne changerait rien)
  const held = !!blockedAbove && on;
  return (
    <li className="flag-row">
      <div className="flag-name">
        <span>{label}</span>
        <span className={"flag-state " + (on && !held ? "is-on" : "is-off") + (held ? " is-held" : "")}>{held ? "Désactivée (par « Tout mon espace »)" : on ? "Active" : "Désactivée"}</span>
      </div>
      {!held && (
        <ActionForm need="property.manage" action={setFlagAction} hidden={{ flag, scope, scopeId, enabled: on ? "0" : "1" }} className="flag-form">
          <Submit className={on ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"} pendingLabel="Enregistrement…">{on ? "Désactiver" : "Réactiver"}</Submit>
        </ActionForm>
      )}
    </li>
  );
}

export function FlagsPanel({ rows, properties }: { rows: FlagRow[]; properties: { id: string; name: string }[] }) {
  return (
    <div className="flag-list">
      {FLAGS.map((f) => {
        const tenantOn = resolveFlag(f.id, rows, {}).enabled;
        return (
          <article className="flag-card" key={f.id} aria-labelledby={"flag-" + f.id}>
            <h3 id={"flag-" + f.id}>{f.label}</h3>
            <p className="section-note">{f.effect}</p>
            <ul className="flag-rows">
              <Toggle flag={f.id} scope="TENANT" scopeId={TENANT_SCOPE_ID} label="Tout mon espace" on={tenantOn} />
              {f.scopes.includes("INTEGRATION") && FLAG_PROVIDERS.map((p) => {
                const own = resolveFlag(f.id, rows.filter((r) => r.scope !== "TENANT"), { provider: p }).enabled;
                return <Toggle key={p} flag={f.id} scope="INTEGRATION" scopeId={p} label={PROVIDER_INFO[p].name} on={own} blockedAbove={!tenantOn ? "t" : null} />;
              })}
              {f.scopes.includes("PROPERTY") && properties.map((p) => {
                const own = resolveFlag(f.id, rows.filter((r) => r.scope !== "TENANT"), { propertyId: p.id }).enabled;
                return <Toggle key={p.id} flag={f.id} scope="PROPERTY" scopeId={p.id} label={p.name} on={own} blockedAbove={!tenantOn ? "t" : null} />;
              })}
            </ul>
          </article>
        );
      })}
    </div>
  );
}

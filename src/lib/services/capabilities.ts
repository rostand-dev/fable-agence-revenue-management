import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { AccountFacts, Provider } from "../integrations/capabilities";
import { currentGates, KILL_SWITCH_PROVIDERS, PROVIDERS } from "../integrations/capabilities";

export type ProviderFacts = AccountFacts & { degraded: boolean; lastSyncAt: Date | null };

/**
 * Ce que l'on sait de chaque fournisseur pour un propriétaire, déduit de ses logements (US-002) :
 * rattachement réel (`listingId` PriceLabs, `rentalId` SuperHote), dernière lecture et échec éventuel.
 * Le coupe-circuit vient de la ligne `integrations` ; rien d'autre n'y est lu.
 */
export async function loadProviderFacts(tenantId: string): Promise<Record<Provider, ProviderFacts>> {
  const [props, ints] = await Promise.all([
    db.select({ isDemo: schema.properties.isDemo, pricelabs: schema.properties.pricelabs, superhote: schema.properties.superhote }).from(schema.properties).where(eq(schema.properties.tenantId, tenantId)),
    db.select().from(schema.integrations).where(eq(schema.integrations.tenantId, tenantId)),
  ]);
  const real = props.filter((p) => !p.isDemo), demoCount = props.length - real.length;
  const out = {} as Record<Provider, ProviderFacts>;
  for (const provider of PROVIDERS) {
    const row = ints.find((i) => i.provider === provider);
    const key = provider === "pricelabs" ? "pricelabs" : provider === "superhote" ? "superhote" : null;
    const linked = key ? real.filter((p) => (key === "pricelabs" ? p.pricelabs?.listingId : p.superhote?.rentalId)) : [];
    const syncs = linked.map((p) => (key === "pricelabs" ? p.pricelabs : p.superhote)?.lastSync).filter(Boolean) as { ok?: boolean; at?: string }[];
    const times = syncs.map((s) => (s.at ? new Date(s.at) : null)).filter((d): d is Date => !!d && !Number.isNaN(+d));
    out[provider] = {
      gates: currentGates(), realTotal: real.length, realLinked: linked.length, demoCount, killSwitch: !!row?.killSwitch && KILL_SWITCH_PROVIDERS.includes(provider), // un ancien coupe-circuit sur un fournisseur sans écriture automatique n'a plus d'effet : on ne l'affiche pas
      degraded: syncs.some((s) => s.ok === false),
      // sans logement réel branché, la seule synchronisation connue est celle de la démonstration
      lastSyncAt: times.length ? new Date(Math.max(...times.map(Number))) : linked.length ? null : row?.lastSyncAt ?? null,
    };
  }
  return out;
}

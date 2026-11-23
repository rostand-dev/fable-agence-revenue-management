import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AVAILABILITY, CAPABILITIES, PROVIDERS, currentGates, envGateOpen, PROVIDER_INFO, capabilitiesOf, capabilityFlags, checkWrite, executionBlock, isProvider,
  providerOfTarget, providerStatus, KILL_SWITCH_PROVIDERS, resolveCapability, resolveProvider, type AccountFacts,
} from "./capabilities";
import { renderCapabilitiesMarkdown } from "./capabilities-doc";

const none: AccountFacts = { realTotal: 0, realLinked: 0, demoCount: 0, killSwitch: false };
const real = (linked: number, total = 2, killSwitch = false): AccountFacts => ({ realTotal: total, realLinked: linked, demoCount: 0, killSwitch });
const demo: AccountFacts = { realTotal: 0, realLinked: 0, demoCount: 2, killSwitch: false };
const cap = (id: string) => CAPABILITIES.find((c) => c.id === id)!;
const read = (f: string) => readFileSync(resolve(__dirname, f), "utf8");

describe("catalogue des capacités", () => {
  it("couvre les huit capacités du blueprint (§4.2) et chaque fournisseur", () => {
    expect(CAPABILITIES.map((c) => c.id).sort()).toEqual([
      "airbnb.promotions.read", "airbnb.promotions.write", "booking.promotions.read", "booking.promotions.write",
      "pricelabs.read", "pricelabs.write", "superhote.reconcile", "superhote.webhooks",
    ]);
    for (const p of PROVIDERS) { expect(capabilitiesOf(p).length, p).toBeGreaterThan(0); expect(PROVIDER_INFO[p].name).toBeTruthy(); }
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(CAPABILITIES.length);
  });
  it("préfixe chaque identifiant par son fournisseur et dit toujours ce qui manque", () => {
    for (const c of CAPABILITIES) { expect(c.id.startsWith(c.provider + "."), c.id).toBe(true); expect(c.detail.length, c.id).toBeGreaterThan(30); }
    for (const c of CAPABILITIES.filter((x) => x.built === "NONE")) expect(["PARTNER_ACCESS", "POLICY"].includes(c.blocker ?? "") || c.id === "superhote.webhooks", c.id).toBe(true);
  });
  it("la seule écriture réelle est celle de PriceLabs, et elle est verrouillée par une variable d'environnement", () => {
    const real = CAPABILITIES.filter((c) => c.kind === "write" && c.built === "REAL");
    expect(real.map((c) => c.id)).toEqual(["pricelabs.write"]);
    expect(real[0].envGate).toBe("PRICELABS_WRITE_ENABLED");
    expect(CAPABILITIES.filter((c) => c.envGate).map((c) => c.id)).toEqual(["pricelabs.write"]);
    // SuperHote : lecture des réservations, du calendrier et des logements ; la seule écriture est la gestion des abonnements webhook (/webhooks), jamais une réservation ni un prix
    const sh = read("superhote.ts");
    expect(sh).not.toMatch(/"(PUT|PATCH)"/);
    const writes = [...sh.matchAll(/call\(token, ([^,)]+)[^)]*\{ method: "(POST|DELETE)"/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    for (const target of writes) expect(target, "écriture SuperHote hors /webhooks").toMatch(/\/webhooks/);
    // PriceLabs, client de LECTURE : le seul POST est la lecture de la grille (`/listing_prices`) ; aucune méthode d'écriture
    const pl = read("pricelabs.ts");
    expect(pl).not.toMatch(/"(PUT|PATCH|DELETE)"/);
    expect([...pl.matchAll(/method: "POST"/g)]).toHaveLength(1);
    expect(pl).toMatch(/"\/listing_prices", \{ method: "POST"/);
    // PriceLabs, client d'ÉCRITURE (épic 9) : jamais PUT ni PATCH ; POST (limites, prix datés) et DELETE (prix datés) seulement, sur deux chemins
    const w = read("pricelabs-write.ts");
    expect(w).not.toMatch(/"(PUT|PATCH)"/);
    expect([...w.matchAll(/this\.send\("(POST|DELETE)", ([^,]+)/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual([
      'DELETE `/listings/${q(id)}/overrides`', 'POST "/listings"', 'POST `/listings/${q(id)}/overrides`', 'POST `/listings/${q(id)}/overrides`',
    ]);
  });
});

describe("état effectif d'une capacité", () => {
  it("lecture développée : à connecter, simulée en démonstration, disponible dès qu'un logement réel est branché", () => {
    expect(resolveCapability(cap("pricelabs.read"), none).status).toBe("NEEDS_CONNECTION");
    expect(resolveCapability(cap("pricelabs.read"), real(0)).status).toBe("NEEDS_CONNECTION");
    expect(resolveCapability(cap("pricelabs.read"), demo).status).toBe("SIMULATED");
    const ok = resolveCapability(cap("pricelabs.read"), real(1));
    expect(ok.status).toBe("AVAILABLE");
    expect(ok.reason).toContain("1 logement sur 2");
    expect(resolveCapability(cap("superhote.reconcile"), real(2)).reason).toContain("2 logements sur 2");
  });
  it("l'écriture PriceLabs : simulée en démonstration, fermée sur un logement réel tant que le verrou d'environnement n'est pas ouvert", () => {
    expect(resolveCapability(cap("pricelabs.write"), demo).status).toBe("SIMULATED");
    // verrou absent ou fermé : désactivée, jamais utilisable
    for (const gates of [undefined, {} as Record<string, boolean>, { PRICELABS_WRITE_ENABLED: false }] as (Record<string, boolean> | undefined)[]) {
      const r = resolveCapability(cap("pricelabs.write"), { ...real(2), gates });
      expect(r.status).toBe("DISABLED"); expect(r.usable).toBe(false); expect(r.reason).toContain("PRICELABS_WRITE_ENABLED");
    }
    // verrou ouvert : disponible
    const open = resolveCapability(cap("pricelabs.write"), { ...real(2), gates: { PRICELABS_WRITE_ENABLED: true } });
    expect(open.status).toBe("AVAILABLE"); expect(open.usable).toBe(true);
    // aucun logement branché : à connecter, même verrou ouvert
    expect(resolveCapability(cap("pricelabs.write"), { ...none, gates: { PRICELABS_WRITE_ENABLED: true } }).status).toBe("NEEDS_CONNECTION");
    // un coupe-circuit prime sur un verrou ouvert
    expect(resolveCapability(cap("pricelabs.write"), { ...real(2, 2, true), gates: { PRICELABS_WRITE_ENABLED: true } })).toMatchObject({ status: "AVAILABLE", killed: true, usable: false });
  });
  it("le verrou d'environnement se lit à chaque appel et n'accepte que « true »", () => {
    const d = cap("pricelabs.write");
    expect(envGateOpen(d, {})).toBe(false);
    for (const v of ["", "false", "0", "yes", "oui", "1"]) expect(envGateOpen(d, { PRICELABS_WRITE_ENABLED: v }), v).toBe(false);
    for (const v of ["true", "TRUE", " true "]) expect(envGateOpen(d, { PRICELABS_WRITE_ENABLED: v }), v).toBe(true);
    expect(envGateOpen(cap("pricelabs.read"), {})).toBe(true); // pas de verrou : ouverte
    expect(currentGates({ PRICELABS_WRITE_ENABLED: "true" })).toEqual({ PRICELABS_WRITE_ENABLED: true });
    expect(currentGates({})).toEqual({ PRICELABS_WRITE_ENABLED: false });
  });
  it("capacités non développées : dépendance visible, jamais disponible", () => {
    expect(resolveCapability(cap("booking.promotions.read"), real(2)).status).toBe("NEEDS_ACCESS");
    expect(resolveCapability(cap("booking.promotions.write"), demo).status).toBe("NEEDS_ACCESS");
    expect(resolveCapability(cap("airbnb.promotions.write"), real(2)).status).toBe("FORBIDDEN");
    for (const p of ["booking", "airbnb"] as const) for (const f of [none, demo, real(2)]) expect(resolveProvider(p, f).every((c) => !c.usable)).toBe(true);
  });
  it("le coupe-circuit bloque l'écriture seulement, la lecture continue", () => {
    const killedDemo = { ...demo, killSwitch: true };
    const w = resolveCapability(cap("pricelabs.write"), killedDemo);
    expect(w).toMatchObject({ status: "SIMULATED", killed: true, usable: false });
    const r = resolveCapability(cap("pricelabs.read"), { ...real(1), killSwitch: true });
    expect(r).toMatchObject({ status: "AVAILABLE", killed: false, usable: true });
  });
  it("chaque état a un libellé, jamais la couleur seule", () => {
    for (const s of Object.keys(AVAILABILITY)) expect(AVAILABILITY[s as keyof typeof AVAILABILITY].label.length).toBeGreaterThan(3);
  });
});

describe("garde d'écriture", () => {
  it("accepte l'écriture PriceLabs simulée sur la démonstration, coupe-circuit levé", () => {
    expect(checkWrite("pricelabs.write", { isDemo: true, killSwitch: false })).toEqual({ ok: true, simulated: true });
  });
  it("refuse l'écriture PriceLabs sur un logement réel tant que le verrou d'environnement est fermé", () => {
    for (const gateOpen of [undefined, false]) {
      const w = checkWrite("pricelabs.write", { isDemo: false, killSwitch: false, gateOpen });
      expect(w).toMatchObject({ ok: false, code: "DISABLED" });
      expect((w as { reason: string }).reason).toContain("procédure manuelle");
      expect((w as { reason: string }).reason).toContain("PRICELABS_WRITE_ENABLED");
    }
  });
  it("autorise l'écriture PriceLabs sur un logement réel quand le verrou est ouvert, et la démonstration reste simulée", () => {
    expect(checkWrite("pricelabs.write", { isDemo: false, killSwitch: false, gateOpen: true })).toEqual({ ok: true, simulated: false });
    expect(checkWrite("pricelabs.write", { isDemo: true, killSwitch: false, gateOpen: true })).toEqual({ ok: true, simulated: true });
    expect(checkWrite("pricelabs.write", { isDemo: false, killSwitch: true, gateOpen: true })).toMatchObject({ ok: false, code: "KILL_SWITCH" });
  });
  it("refuse sous coupe-circuit, même sur la démonstration", () => {
    expect(checkWrite("pricelabs.write", { isDemo: true, killSwitch: true })).toMatchObject({ ok: false, code: "KILL_SWITCH" });
  });
  it("refuse toute écriture non développée, partout, et toute capacité inconnue ou en lecture", () => {
    for (const id of ["booking.promotions.write", "airbnb.promotions.write"]) for (const isDemo of [true, false]) expect(checkWrite(id, { isDemo, killSwitch: false }), id).toMatchObject({ ok: false, code: "NOT_SUPPORTED" });
    expect(checkWrite("superhote.write", { isDemo: true, killSwitch: false })).toMatchObject({ ok: false, code: "UNKNOWN_CAPABILITY" });
    expect(checkWrite("pricelabs.read", { isDemo: true, killSwitch: false })).toMatchObject({ ok: false, code: "UNKNOWN_CAPABILITY" });
  });
  it("aucune écriture du catalogue n'est autorisée sur un logement réel", () => {
    for (const c of CAPABILITIES.filter((x) => x.kind === "write")) expect(checkWrite(c.id, { isDemo: false, killSwitch: false }).ok, c.id).toBe(false);
  });
});

describe("blocage d'exécution (API et fiche du dossier)", () => {
  const ok = { provider: "pricelabs" as const, isDemo: true, killSwitch: false };
  it("laisse passer l'écriture simulée de démonstration, la procédure manuelle et la tâche interne", () => {
    expect(executionBlock("API_PRICELABS", ok)).toBeNull();
    expect(executionBlock("MANUAL_RUNBOOK", { provider: "booking", isDemo: false, killSwitch: false })).toBeNull();
    expect(executionBlock("INTERNAL", { provider: null, isDemo: false, killSwitch: false })).toBeNull();
  });
  it("bloque l'écriture par API sur un logement réel et sous coupe-circuit", () => {
    expect(executionBlock("API_PRICELABS", { ...ok, isDemo: false })).toContain("procédure manuelle"); // verrou d'environnement fermé
    expect(executionBlock("API_PRICELABS", { ...ok, isDemo: false, gateOpen: false })).toContain("PRICELABS_WRITE_ENABLED");
    expect(executionBlock("API_PRICELABS", { ...ok, killSwitch: true })).toContain("Coupe-circuit");
  });
  it("le coupe-circuit ne coupe que l'API : la procédure manuelle reste possible", () => {
    expect(executionBlock("MANUAL_RUNBOOK", { provider: "pricelabs", isDemo: false, killSwitch: true })).toBeNull();
    expect(executionBlock("MANUAL_RUNBOOK", { provider: "booking", isDemo: false, killSwitch: true })).toBeNull();
    expect(KILL_SWITCH_PROVIDERS).toEqual(["pricelabs"]);
  });
  it("refuse un mode inconnu ou une future écriture API sans capacité", () => {
    expect(executionBlock("NONE", ok)).toContain("inconnu");
    expect(executionBlock("API_BOOKING", ok)).toContain("inconnu");
    expect(executionBlock(undefined, ok)).toContain("inconnu");
  });
  it("une écriture API visant un autre fournisseur que PriceLabs est refusée, même sans coupe-circuit", () => {
    expect(executionBlock("API_PRICELABS", { provider: "booking", isDemo: true, killSwitch: false })).toContain("incohérente");
    expect(executionBlock("API_PRICELABS", { provider: null, isDemo: true, killSwitch: false })).toContain("incohérente");
  });
  it("une tâche interne avec fournisseur reste possible sous coupe-circuit", () => {
    expect(executionBlock("INTERNAL", { provider: "pricelabs", isDemo: true, killSwitch: true })).toBeNull();
  });
  it("une tâche interne n'est pas concernée par un coupe-circuit", () => {
    expect(executionBlock("INTERNAL", { provider: null, isDemo: false, killSwitch: true })).toBeNull();
  });
});

describe("types d'action écrits par l'API (épic 9)", () => {
  const live = { provider: "pricelabs" as const, isDemo: false, killSwitch: false, gateOpen: true };
  it("sur un logement réel au verrou ouvert, seuls les types écrits par l'API s'exécutent", () => {
    for (const t of ["MIN_PRICE_CHANGE", "BASE_PRICE_CHANGE", "PRICE_OVERRIDE", "RULE_EXCLUSION"]) expect(executionBlock("API_PRICELABS", { ...live, actionType: t }), t).toBeNull();
    expect(executionBlock("API_PRICELABS", { ...live, actionType: "MIN_STAY_OVERRIDE" })).toContain("ne s'écrit pas par l'API");
    expect(executionBlock("API_PRICELABS", { ...live, actionType: "N_IMPORTE_QUOI" })).toContain("ne s'écrit pas par l'API");
  });
  it("la démonstration simule tous les types, séjour minimum compris", () => {
    expect(executionBlock("API_PRICELABS", { provider: "pricelabs", isDemo: true, killSwitch: false, actionType: "MIN_STAY_OVERRIDE" })).toBeNull();
  });
  it("le coupe-circuit et le verrou priment sur le type", () => {
    expect(executionBlock("API_PRICELABS", { ...live, killSwitch: true, actionType: "MIN_PRICE_CHANGE" })).toContain("Coupe-circuit");
    expect(executionBlock("API_PRICELABS", { ...live, gateOpen: false, actionType: "MIN_PRICE_CHANGE" })).toContain("PRICELABS_WRITE_ENABLED");
  });
});

describe("drapeaux et statuts", () => {
  it("drapeaux d'un logement : écriture PriceLabs vraie en démonstration, ou sur un logement réel si le verrou est ouvert, et jamais sous coupe-circuit", () => {
    expect(capabilityFlags({ isDemo: true, killSwitch: {} })["pricelabs.write"]).toBe(true);
    expect(capabilityFlags({ isDemo: false, killSwitch: {}, gates: {} })["pricelabs.write"]).toBe(false);
    expect(capabilityFlags({ isDemo: false, killSwitch: {}, gates: { PRICELABS_WRITE_ENABLED: true } })["pricelabs.write"]).toBe(true);
    expect(capabilityFlags({ isDemo: false, killSwitch: { pricelabs: true }, gates: { PRICELABS_WRITE_ENABLED: true } })["pricelabs.write"]).toBe(false);
    expect(capabilityFlags({ isDemo: true, killSwitch: { pricelabs: true } })["pricelabs.write"]).toBe(false);
    const f = capabilityFlags({ isDemo: false, killSwitch: {} });
    expect(f["pricelabs.read"]).toBe(true); expect(f["superhote.webhooks"]).toBe(true); expect(f["booking.promotions.write"]).toBe(false);
    expect(Object.keys(f).sort()).toEqual(CAPABILITIES.map((c) => c.id).sort());
  });
  it("statut d'un fournisseur déduit des logements", () => {
    expect(providerStatus("pricelabs", none)).toBe("NOT_CONNECTED");
    expect(providerStatus("pricelabs", demo)).toBe("DEMO");
    expect(providerStatus("superhote", real(1))).toBe("CONNECTED");
    expect(providerStatus("superhote", { ...real(1), degraded: true })).toBe("DEGRADED");
    expect(providerStatus("booking", real(2))).toBe("NOT_CONNECTED");
    expect(providerStatus("airbnb", demo)).toBe("NOT_CONNECTED");
  });
  it("reconnaît les fournisseurs et les cibles d'action", () => {
    expect(isProvider("pricelabs")).toBe(true); expect(isProvider("stripe")).toBe(false); expect(isProvider(undefined)).toBe(false);
    expect(providerOfTarget("PRICELABS")).toBe("pricelabs"); expect(providerOfTarget("BOOKING")).toBe("booking");
    expect(providerOfTarget("AIRBNB")).toBe("airbnb"); expect(providerOfTarget("INTERNAL")).toBeNull(); expect(providerOfTarget(undefined)).toBeNull();
  });
});

describe("documentation", () => {
  it("garde docs/capacites-integrations.md synchronisé (npm run docs:capabilities)", () => {
    const committed = readFileSync(resolve(__dirname, "..", "..", "..", "docs", "capacites-integrations.md"), "utf8");
    expect(committed.replace(/\r\n/g, "\n"), "Le document est périmé : lancez `npm run docs:capabilities` et commitez-le").toBe(renderCapabilitiesMarkdown());
  });
});

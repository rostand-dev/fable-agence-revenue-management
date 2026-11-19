import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AVAILABILITY, CAPABILITIES, PROVIDERS, PROVIDER_INFO, capabilitiesOf, capabilityFlags, checkWrite, executionBlock, isProvider,
  providerOfTarget, providerStatus, resolveCapability, resolveProvider, type AccountFacts,
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
  it("ne déclare aucune écriture réelle : aucun client du code n'écrit chez un fournisseur", () => {
    expect(CAPABILITIES.filter((c) => c.kind === "write" && c.built === "REAL")).toEqual([]);
    // SuperHote : lecture seule, uniquement des GET
    expect(read("superhote.ts")).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
    // PriceLabs : le seul POST est la lecture de la grille (`/listing_prices`) ; aucune autre méthode d'écriture
    const pl = read("pricelabs.ts");
    expect(pl).not.toMatch(/"(PUT|PATCH|DELETE)"/);
    expect([...pl.matchAll(/method: "POST"/g)]).toHaveLength(1);
    expect(pl).toMatch(/"\/listing_prices", \{ method: "POST"/);
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
  it("l'écriture PriceLabs n'existe qu'en simulation sur la démonstration, jamais sur un logement réel", () => {
    expect(resolveCapability(cap("pricelabs.write"), demo).status).toBe("SIMULATED");
    expect(resolveCapability(cap("pricelabs.write"), real(2)).status).toBe("NOT_BUILT");
    expect(resolveCapability(cap("pricelabs.write"), real(2)).usable).toBe(false);
    expect(resolveCapability(cap("pricelabs.write"), none).status).toBe("NOT_BUILT");
  });
  it("capacités non développées : dépendance visible, jamais disponible", () => {
    expect(resolveCapability(cap("superhote.webhooks"), real(2)).status).toBe("NOT_BUILT");
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
  it("refuse l'écriture PriceLabs sur un logement réel", () => {
    const w = checkWrite("pricelabs.write", { isDemo: false, killSwitch: false });
    expect(w).toMatchObject({ ok: false, code: "NOT_SUPPORTED" });
    expect((w as { reason: string }).reason).toContain("procédure manuelle");
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
    expect(executionBlock("API_PRICELABS", { ...ok, isDemo: false })).toContain("procédure manuelle");
    expect(executionBlock("API_PRICELABS", { ...ok, killSwitch: true })).toContain("Coupe-circuit");
    expect(executionBlock("MANUAL_RUNBOOK", { provider: "booking", isDemo: false, killSwitch: true })).toContain("Coupe-circuit");
  });
  it("refuse un mode inconnu ou une future écriture API sans capacité", () => {
    expect(executionBlock("NONE", ok)).toContain("inconnu");
    expect(executionBlock("API_BOOKING", ok)).toContain("inconnu");
    expect(executionBlock(undefined, ok)).toContain("inconnu");
  });
  it("une tâche interne n'est pas concernée par un coupe-circuit", () => {
    expect(executionBlock("INTERNAL", { provider: null, isDemo: false, killSwitch: true })).toBeNull();
  });
});

describe("drapeaux et statuts", () => {
  it("drapeaux d'un logement : écriture PriceLabs vraie seulement en démonstration et sans coupe-circuit", () => {
    expect(capabilityFlags({ isDemo: true, killSwitch: {} })["pricelabs.write"]).toBe(true);
    expect(capabilityFlags({ isDemo: false, killSwitch: {} })["pricelabs.write"]).toBe(false);
    expect(capabilityFlags({ isDemo: true, killSwitch: { pricelabs: true } })["pricelabs.write"]).toBe(false);
    const f = capabilityFlags({ isDemo: false, killSwitch: {} });
    expect(f["pricelabs.read"]).toBe(true); expect(f["superhote.webhooks"]).toBe(false); expect(f["booking.promotions.write"]).toBe(false);
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

import { describe, expect, it, vi } from "vitest";
import { containsPii, installLogMasking, isPiiKey, isTravellerKey, maskLogArgs, maskPii, pickAllowed, PII_MASK, redactPii } from "./pii";

describe("maskPii : ce qui doit être masqué", () => {
  it.each([
    ["marie.dupont+resa@example.com", "[e-mail masqué]"],
    ["Contact : jean_martin@sous.domaine.fr, merci", "Contact : [e-mail masqué], merci"],
  ])("e-mail : %s", (input, expected) => expect(maskPii(input)).toBe(expected));

  it.each(["06 12 34 56 78", "06.12.34.56.78", "0612345678", "06-12-34-56-78", "+33 6 12 34 56 78", "+33612345678", "0033 6 12 34 56 78", "+1 (555) 123-4567", "+44 7700 900123"])("téléphone : %s", (tel) => {
    expect(maskPii(`Appeler le ${tel} demain`)).toBe("Appeler le [téléphone masqué] demain");
  });

  it("IBAN valide (clé modulo 97), avec ou sans espaces", () => {
    expect(maskPii("IBAN FR1420041010050500013M02606 ok")).toBe("IBAN [IBAN masqué] ok");
    expect(maskPii("FR14 2004 1010 0505 0001 3M02 606")).toBe("[IBAN masqué]");
  });
  it("carte bancaire valide (clé de Luhn), avec ou sans séparateurs", () => {
    expect(maskPii("carte 4111111111111111 fin")).toBe("carte [carte masquée] fin");
    expect(maskPii("carte 4111 1111 1111 1111")).toBe("carte [carte masquée]");
    expect(maskPii("carte 4111-1111-1111-1111")).toBe("carte [carte masquée]");
  });
  it("secrets : secret de webhook, clé Anthropic, Bearer, jeton dans l'adresse du webhook, paires clé=valeur", () => {
    expect(maskPii("secret whsec_AbCdEf0123456789xyz")).toBe("secret [secret masqué]");
    expect(maskPii("clé sk-ant-api03-AbCdEf0123456789")).toBe("clé [secret masqué]");
    expect(maskPii("Authorization: Bearer abcdefghijklmnop1234")).toContain("[secret masqué]");
    expect(maskPii("POST /api/v1/webhooks/superhote/Ab12Cd34Ef56Gh78Ij90 200")).toBe("POST /api/v1/webhooks/superhote/[secret masqué] 200");
    expect(maskPii('{"apiKey":"abcd1234efgh"}')).toBe('{"apiKey":"[secret masqué]"}');
    expect(maskPii("password=hunter2hunter2")).toBe("password=[secret masqué]");
  });
  it("plusieurs données dans une même phrase", () => {
    expect(maskPii("Anne (anne@x.fr, 06 11 22 33 44) a payé")).toBe("Anne ([e-mail masqué], [téléphone masqué]) a payé");
  });
  it("containsPii", () => { expect(containsPii("a@b.fr")).toBe(true); expect(containsPii("rien ici")).toBe(false); });
});

describe("maskPii : ce qui ne doit PAS être masqué (aucun faux positif sur les données métier)", () => {
  it.each([
    "2026-11-21", "2026-11-21T13:18:00+01:00", "du 2026-11-21 au 2026-11-28", "135,50 €", "1 250,00 €", "1234567.89", "17 % de commission",
    "res_0123456789ab", "98765", "1795259253006", "9f1f3c2a-8b7d-4c11-a0aa-0123456789ab", "pl_listing_0612345678x",
    "T3 Châtillon, 4 voyageurs, 2 chambres", "192.168.1.10", "v1.2.3", "airbnb 23 % de majoration", "FR76 est un préfixe", "AB12 pas un IBAN",
    "1234567890123456", // 16 chiffres qui ne passent pas la clé de Luhn
    "+2026-12-01", "variation +20 12 2026", "prix 0612345678.50", "0612345678,50", "id 0612345678-1", "nuits 2026-12-01 2026-12-02 2026-12-03", "du 2026-12-01 2026-12-08 au 2026-12-15", "séjour 12-00 15 30 45 60",
  ])("laisse intact : %s", (s) => expect(maskPii(s)).toBe(s));
  it("une chaîne vide ou sans donnée est rendue telle quelle", () => { expect(maskPii("")).toBe(""); expect(maskPii("Bonjour")).toBe("Bonjour"); });
});

describe("redactPii (copie profonde)", () => {
  it("masque les clés d'identité du voyageur, quel que soit le contenu, et nettoie le texte des autres champs", () => {
    const out = redactPii({ id: 42, guest: { first_name: "Anne", last_name: "Martin" }, guest_email: "a@b.fr", guestPhone: "0611223344", note: "écrire à x@y.fr", nights: 3, guests_count: 2, children_count: 1 }) as Record<string, unknown>;
    expect(out).toEqual({ id: 42, guest: PII_MASK, guest_email: PII_MASK, guestPhone: PII_MASK, note: "écrire à [e-mail masqué]", nights: 3, guests_count: 2, children_count: 1 });
  });
  it("garde les compteurs et valeurs vides ; les clés ne sont pas sensibles à la casse ni au format", () => {
    expect(isPiiKey("guests_count")).toBe(false); expect(isPiiKey("guest_count")).toBe(false); expect(isPiiKey("checkin")).toBe(false); expect(isPiiKey("message")).toBe(false);
    for (const k of ["guest", "Guest", "guestName", "guest-name", "first_name", "firstName", "lastName", "email", "Phone", "private_notes", "dateOfBirth", "passport_number"]) expect(isPiiKey(k), k).toBe(true);
    expect(redactPii({ guest_email: null, phone: "" })).toEqual({ guest_email: null, phone: "" });
  });
  it("traverse tableaux, Map et Set ; conserve les dates ; ne plante pas sur un cycle ni sur une structure très profonde", () => {
    const d = new Date("2026-11-21T00:00:00Z");
    expect(redactPii([{ email: "a@b.fr" }, "x@y.fr", d, new Set(["z@w.fr"]), new Map([["k", "q@r.fr"]])])).toEqual([{ email: PII_MASK }, "[e-mail masqué]", d, ["[e-mail masqué]"], [["k", "[e-mail masqué]"]]]);
    const cyc: any = { a: 1 }; cyc.self = cyc;
    expect(redactPii(cyc)).toEqual({ a: 1, self: "[référence circulaire]" });
    let deep: any = { v: 1 }; for (let i = 0; i < 30; i++) deep = { d: deep };
    expect(() => redactPii(deep)).not.toThrow();
  });
  it("une erreur garde sa classe et sa pile mais perd les données personnelles (message, détail, cause)", () => {
    class DbError extends Error { detail = "Key (email)=(marie@x.fr) already exists."; }
    const err = new DbError("duplicate key for marie@x.fr", { cause: new Error("tel 06 12 34 56 78") });
    const safe = redactPii(err) as DbError;
    expect(safe).toBeInstanceOf(DbError);
    expect(safe.message).toBe("duplicate key for [e-mail masqué]");
    expect(safe.detail).toBe("Key (email)=([e-mail masqué]) already exists.");
    expect(String(safe.stack)).not.toContain("marie@x.fr");
    expect((safe.cause as Error).message).toBe("tel [téléphone masqué]");
  });
});

describe("pickAllowed (minimisation à l'entrée)", () => {
  const payload = { id: 7, rental_id: "12", checkin: "2026-12-01", total_price: 400.5, guest: { first_name: "Anne", email: "a@b.fr" }, guest_email: "a@b.fr", private_notes: "code 1234", price_details: [{ type: "cleaning_fee", total: 50 }], extra: { deep: { keep: 1, drop: 2 } } };
  it("ne garde que les chemins autorisés, ignore ce qui est absent, n'invente rien", () => {
    expect(pickAllowed(payload, ["id", "rental_id", "checkin", "price_details", "extra.deep.keep", "absent", "guest.nope"])).toEqual({ id: 7, rental_id: "12", checkin: "2026-12-01", price_details: [{ type: "cleaning_fee", total: 50 }], extra: { deep: { keep: 1 } } });
  });
  it("un champ non listé n'entre jamais, même s'il apparaît plus tard dans l'API", () => {
    const out = pickAllowed({ ...payload, new_field: "?" }, ["id"]);
    expect(Object.keys(out)).toEqual(["id"]);
  });
  it("source nulle ou non objet : résultat vide", () => { expect(pickAllowed(null, ["a"])).toEqual({}); expect(pickAllowed("x", ["a.b"])).toEqual({}); });
});

describe("journaux", () => {
  const fake = () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  it("maskLogArgs nettoie chaîne, objet et erreur, laisse nombres et booléens", () => {
    const [a, b, c, d, e] = maskLogArgs(["à a@b.fr", { guest_email: "a@b.fr", n: 1 }, new Error("tel 0611223344"), 5, true]) as [string, Record<string, unknown>, Error, number, boolean];
    expect(a).toBe("à [e-mail masqué]"); expect(b).toEqual({ guest_email: PII_MASK, n: 1 }); expect(c.message).toBe("tel [téléphone masqué]"); expect(d).toBe(5); expect(e).toBe(true);
  });
  it("installLogMasking enveloppe les cinq niveaux, une seule fois", () => {
    const c = fake(); const originals = { ...c };
    expect(installLogMasking(c as never, {})).toBe(true);
    expect(installLogMasking(c as never, {})).toBe(false);
    c.error("[x]", "anne@x.fr", { phone: "0611223344" });
    c.warn("ok");
    expect(originals.error).toHaveBeenCalledWith("[x]", "[e-mail masqué]", { phone: PII_MASK });
    expect(originals.warn).toHaveBeenCalledWith("ok");
    for (const l of ["log", "info", "debug"] as const) { c[l]("a@b.fr"); expect(originals[l]).toHaveBeenCalledWith("[e-mail masqué]"); }
  });
  it("LOG_PII_MASKING=off désactive l'enveloppe (débogage local)", () => {
    const c = fake(); const originals = { ...c };
    expect(installLogMasking(c as never, { LOG_PII_MASKING: "off" })).toBe(false);
    c.log("a@b.fr"); expect(originals.log).toHaveBeenCalledWith("a@b.fr");
  });
  it("un contenu impossible à nettoyer n'est jamais affiché tel quel, et ne fait pas planter l'appelant", () => {
    const c = fake(); const originals = { ...c };
    installLogMasking(c as never, {});
    const hostile = new Proxy({}, { ownKeys() { throw new Error("boom"); } });
    expect(() => c.error(hostile)).not.toThrow();
    expect(originals.error).toHaveBeenCalledWith("[argument illisible : non affiché par précaution]");
  });
});

describe("clés de voyageur et de contact", () => {
  it("isTravellerKey ne retient que l'identité du voyageur ; isPiiKey y ajoute les coordonnées", () => {
    for (const k of ["guest", "guestName", "first_name", "private_notes", "passport_number"]) { expect(isTravellerKey(k), k).toBe(true); expect(isPiiKey(k), k).toBe(true); }
    for (const k of ["email", "phone", "zip"]) { expect(isTravellerKey(k), k).toBe(false); expect(isPiiKey(k), k).toBe(true); }
    for (const k of ["guests_count", "name", "city", "message", "notes"]) { expect(isTravellerKey(k), k).toBe(false); expect(isPiiKey(k), k).toBe(false); }
  });
});

describe("relecture US-034 : performance, références partagées, objets spéciaux, secrets", () => {
  it.each(["a".repeat(100_000), "1-".repeat(50_000), "a.".repeat(50_000), "a@".repeat(50_000), "0".repeat(100_000), "1 ".repeat(50_000)])("pas de ReDoS sur une longue entrée (%#)", (big) => {
    const t = Date.now(); maskPii(big); expect(Date.now() - t).toBeLessThan(1000);
  });
  it("un même objet cité deux fois n'est pas un cycle", () => {
    const sh = { a: "x@y.fr" }; expect(redactPii({ a: sh, b: sh, l: [sh, sh] })).toEqual({ a: { a: "[e-mail masqué]" }, b: { a: "[e-mail masqué]" }, l: [{ a: "[e-mail masqué]" }, { a: "[e-mail masqué]" }] });
  });
  it("URL, Headers, AggregateError et instances de classe gardent l'essentiel, sans donnée personnelle", () => {
    expect(redactPii(new URL("https://x.fr/p?mail=a@b.fr"))).toBe("https://x.fr/p?mail=[e-mail masqué]");
    expect(redactPii(new Headers({ authorization: "Bearer abcdefghijkl", accept: "json" }))).toEqual({ authorization: "[secret masqué]", accept: "json" });
    const agg = redactPii(new AggregateError([new Error("a@b.fr")], "multi")) as AggregateError; expect(agg.errors[0].message).toBe("[e-mail masqué]");
    class Resa { id = 1; mail = "a@b.fr"; } const r = redactPii(new Resa()) as Resa; expect(r).toBeInstanceOf(Resa); expect(r.mail).toBe("[e-mail masqué]");
  });
  it("les très grands tableaux sont bornés", () => { const out = redactPii(Array.from({ length: 500 }, (_, i) => i)) as unknown[]; expect(out).toHaveLength(201); expect(out[200]).toContain("omis"); });
  it("secrets : Basic, jetons GitHub, AWS, JWT, mot de passe de connexion", () => {
    expect(maskPii("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [secret masqué]");
    expect(maskPii("ghp_abcdefghijklmnopqrstuvwx")).toBe("[secret masqué]");
    expect(maskPii("AKIAABCDEFGHIJKLMNOP")).toBe("[secret masqué]");
    expect(maskPii("eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abc_def")).toBe("[secret masqué]");
    expect(maskPii("postgres://nuit:Sup3rS3cret@db:5432/nuitsignal")).toBe("postgres://nuit:[secret masqué]@db:5432/nuitsignal");
  });
  it("téléphones avec (0) et e-mails Unicode", () => {
    expect(maskPii("+33 (0)6 12 34 56 78")).toBe("[téléphone masqué]");
    expect(maskPii("é@ex.fr")).toBe("[e-mail masqué]");
  });
});

import { describe, expect, it } from "vitest";
import { airbnbIdFromUrl, parseListingInput, parseListingUrl, parseOwnerInput, parsePropertyIdentity, parsePropertyPatch, parseTenantName } from "./portfolio";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const err = (r: { ok: boolean; error?: string }) => { expect(r.ok).toBe(false); return (r as { error: string }).error; };

describe("propriétaire (US-020)", () => {
  it("normalise le nom (espaces) et l'e-mail (minuscules) ; champs facultatifs vides = null", () => {
    expect(ok(parseOwnerInput({ name: "  Marie   Dupont ", email: " Marie@Example.COM ", notes: "" }))).toEqual({ name: "Marie Dupont", email: "marie@example.com", notes: null });
    expect(ok(parseOwnerInput({ name: "SCI Les Lilas" }))).toEqual({ name: "SCI Les Lilas", email: null, notes: null });
  });
  it("refuse un nom trop court ou trop long, un e-mail invalide, des notes démesurées", () => {
    expect(err(parseOwnerInput({ name: "A" }))).toMatch(/au moins 2/);
    expect(err(parseOwnerInput({ name: "x".repeat(81) }))).toMatch(/80/);
    expect(err(parseOwnerInput({ name: "Marie", email: "pas-un-mail" }))).toMatch(/e-mail/);
    expect(err(parseOwnerInput({ name: "Marie", notes: "n".repeat(501) }))).toMatch(/500/);
    expect(err(parseOwnerInput({}))).toMatch(/au moins 2/);
    expect(err(parseOwnerInput({ name: 42 as unknown as string }))).toMatch(/au moins 2/);
  });
});

describe("identité d'un logement", () => {
  const base = { name: "T3 Châtillon", city: "Châtillon", kind: "T3" };
  it("accepte une identité complète ; chambres et capacité vides restent inconnues (null, jamais 0)", () => {
    expect(ok(parsePropertyIdentity({ ...base, bedrooms: "", capacity: undefined }))).toMatchObject({ bedrooms: null, capacity: null, positioning: null, objective: null });
    expect(ok(parsePropertyIdentity({ ...base, bedrooms: "2", capacity: 4, positioning: "Pros" }))).toMatchObject({ bedrooms: 2, capacity: 4, positioning: "Pros" });
  });
  it("refuse nom, ville ou type manquants ; nombres négatifs, décimaux ou hors bornes", () => {
    expect(err(parsePropertyIdentity({ ...base, name: "x" }))).toMatch(/nom/);
    expect(err(parsePropertyIdentity({ ...base, city: "" }))).toMatch(/ville/);
    expect(err(parsePropertyIdentity({ ...base, kind: "" }))).toMatch(/type/);
    expect(err(parsePropertyIdentity({ ...base, bedrooms: -1 }))).toMatch(/Chambres/);
    expect(err(parsePropertyIdentity({ ...base, bedrooms: 2.5 }))).toMatch(/Chambres/);
    expect(err(parsePropertyIdentity({ ...base, capacity: 101 }))).toMatch(/Voyageurs/);
    expect(err(parsePropertyIdentity({ ...base, capacity: "beaucoup" }))).toMatch(/Voyageurs/);
  });
  it("une modification partielle ne change que les champs présents et liste ce qui a changé", () => {
    const cur = ok(parsePropertyIdentity({ ...base, bedrooms: 2, capacity: 4 }));
    const r = ok(parsePropertyPatch({ city: "Paris" }, cur));
    expect(r.identity).toMatchObject({ name: "T3 Châtillon", city: "Paris", bedrooms: 2 });
    expect(r.changed).toEqual(["city"]);
    expect(ok(parsePropertyPatch({ bedrooms: null }, cur)).changed).toEqual(["bedrooms"]);
    // brouillon incomplet : un changement de propriétaire seul ne revalide pas l'identité
    expect(ok(parsePropertyPatch({ ownerId: "own_1" }, { ...cur, city: "", kind: "" })).changed).toEqual([]);
    expect(ok(parsePropertyPatch({}, cur)).changed).toEqual([]);
    expect(err(parsePropertyPatch({ name: "" }, cur))).toMatch(/nom/);
  });
});

describe("annonce", () => {
  it("Airbnb : l'identifiant se déduit de l'adresse, ou doit concorder avec elle", () => {
    expect(ok(parseListingInput({ channel: "AIRBNB", url: "https://www.airbnb.fr/rooms/12345678?adults=2" }))).toEqual({ channel: "AIRBNB", externalId: "12345678", url: "https://www.airbnb.fr/rooms/12345678", title: null });
    expect(err(parseListingInput({ channel: "AIRBNB", externalId: "99999999", url: "https://www.airbnb.fr/rooms/12345678" }))).toMatch(/ne correspond pas/);
    expect(ok(parseListingInput({ channel: "AIRBNB", externalId: "12345678" })).url).toBeNull();
  });
  it("vérifie la forme de l'identifiant selon le canal ; vide = inconnu", () => {
    expect(ok(parseListingInput({ channel: "BOOKING", externalId: "" })).externalId).toBeNull();
    expect(ok(parseListingInput({ channel: "BOOKING", externalId: "1234567" })).externalId).toBe("1234567");
    expect(err(parseListingInput({ channel: "BOOKING", externalId: "abc" }))).toMatch(/Booking/);
    expect(err(parseListingInput({ channel: "AIRBNB", externalId: "12" }))).toMatch(/Airbnb/);
    expect(ok(parseListingInput({ channel: "DIRECT", externalId: "mon-site_1" })).externalId).toBe("mon-site_1");
    expect(err(parseListingInput({ channel: "DIRECT", externalId: "-x" }))).toMatch(/directe/);
  });
  it("refuse un canal inconnu ou un titre trop long", () => {
    expect(err(parseListingInput({ channel: "EXPEDIA" }))).toMatch(/Canal inconnu/);
    expect(err(parseListingInput({}))).toMatch(/Canal inconnu/);
    expect(err(parseListingInput({ channel: "DIRECT", title: "t".repeat(121) }))).toMatch(/120/);
  });
  it("adresse : https obligatoire, domaine cohérent avec le canal, aucun identifiant de connexion", () => {
    expect(ok(parseListingUrl("BOOKING", "https://www.booking.com/hotel/fr/mon-appart.fr.html/"))).toBe("https://www.booking.com/hotel/fr/mon-appart.fr.html");
    expect(err(parseListingUrl("AIRBNB", "http://www.airbnb.fr/rooms/12345678"))).toMatch(/https/);
    expect(err(parseListingUrl("AIRBNB", "https://www.booking.com/x"))).toMatch(/Airbnb/);
    expect(err(parseListingUrl("AIRBNB", "https://airbnb.evil.com/rooms/1"))).toMatch(/Airbnb/);
    expect(err(parseListingUrl("AIRBNB", "https://airbnb.attacker.io/rooms/12345678"))).toMatch(/Airbnb/);
    expect(ok(parseListingUrl("AIRBNB", "https://www.airbnb.co.uk/rooms/12345678"))).toBeTruthy();
    expect(err(parseListingUrl("BOOKING", "https://user:pass@booking.com/x"))).toMatch(/identifiant ni mot de passe/);
    expect(err(parseListingUrl("DIRECT", "pas une adresse"))).toMatch(/adresse web/);
    expect(ok(parseListingUrl("DIRECT", "https://mon-site.fr/chez-moi"))).toBe("https://mon-site.fr/chez-moi");
    expect(err(parseListingUrl("DIRECT", "https://mon-site.fr/" + "a".repeat(300)))).toMatch(/trop longue/);
  });
  it("airbnbIdFromUrl ne lit que le chemin /rooms/<nombre>", () => {
    expect(airbnbIdFromUrl("https://www.airbnb.fr/rooms/12345678")).toBe("12345678");
    expect(airbnbIdFromUrl("https://www.airbnb.fr/rooms/plus/12345678#x")).toBe("12345678");
    expect(airbnbIdFromUrl("https://www.airbnb.fr/s/Paris")).toBeNull();
  });
});

describe("nom de l'espace", () => {
  it("2 à 80 caractères", () => {
    expect(ok(parseTenantName("  Mon   espace "))).toBe("Mon espace");
    expect(err(parseTenantName("a"))).toMatch(/entre 2 et 80/);
    expect(err(parseTenantName("a".repeat(81)))).toMatch(/entre 2 et 80/);
  });
});

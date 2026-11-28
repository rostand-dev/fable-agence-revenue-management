import { describe, expect, it } from "vitest";
import { PATH_HEADER } from "./nav";
import { addForced, FORCE_COOKIE, FORCE_MAX_KEYS, FORCE_MAX_LENGTH, isPhone, parseForced, safeReturnPath, VIEW_COOKIE, viewContext, viewMode } from "./view-mode";

const h = (values: Record<string, string>) => new Headers(values);
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipadBureau: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  tabletteAndroid: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  bureau: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

describe("détection d'un téléphone", () => {
  it("reconnaît iPhone et Android mobile au User-Agent", () => {
    for (const ua of [UA.iphone, UA.android, UA.firefoxAndroid]) expect(isPhone(h({ "user-agent": ua })), ua).toBe(true);
  });
  it("laisse les tablettes et les ordinateurs en version complète", () => {
    for (const ua of [UA.ipad, UA.ipadBureau, UA.tabletteAndroid, UA.bureau, ""]) expect(isPhone(h({ "user-agent": ua })), ua).toBe(false);
    expect(isPhone(h({}))).toBe(false);
  });
  it("suit l'indice Sec-CH-UA-Mobile avant le User-Agent", () => {
    expect(isPhone(h({ "sec-ch-ua-mobile": "?1", "user-agent": UA.bureau }))).toBe(true);
    // « version pour ordinateur » demandée sur un téléphone
    expect(isPhone(h({ "sec-ch-ua-mobile": "?0", "user-agent": UA.android }))).toBe(false);
    expect(isPhone(h({ "sec-ch-ua-mobile": "n'importe quoi", "user-agent": UA.iphone }))).toBe(true);
  });
});

describe("mode d'affichage", () => {
  it("le cookie l'emporte sur l'appareil", () => {
    expect(viewMode("complet", h({ "user-agent": UA.iphone }))).toBe("complet");
    expect(viewMode("poche", h({ "user-agent": UA.bureau }))).toBe("poche");
  });
  it("sans cookie valide, l'appareil décide", () => {
    expect(viewMode(undefined, h({ "user-agent": UA.iphone }))).toBe("poche");
    expect(viewMode("complete", h({ "user-agent": UA.iphone }))).toBe("poche");
    expect(viewMode("", h({ "user-agent": UA.ipad }))).toBe("complet");
  });
});

describe("« Afficher quand même »", () => {
  it("ajoute un choix sans doublon, le plus récent en dernier", () => {
    expect(addForced(undefined, "/bilan")).toBe("/bilan");
    expect(addForced("/bilan,/methode", "/bilan")).toBe("/methode,/bilan");
    expect(parseForced(undefined)).toEqual([]);
    expect(parseForced("/bilan,,creation")).toEqual(["/bilan", "creation"]);
  });
  it("oublie les choix les plus anciens pour que le cookie reste petit", () => {
    let c = "";
    for (let i = 0; i < 100; i++) c = addForced(c, `/logements/prop_${"x".repeat(60)}${i}/couts`);
    expect(c.length).toBeLessThanOrEqual(FORCE_MAX_LENGTH);
    expect(parseForced(c).length).toBeLessThanOrEqual(FORCE_MAX_KEYS);
    expect(parseForced(c).at(-1)).toContain("99/couts");
  });
});

describe("adresse de retour", () => {
  it("garde un chemin interne, paramètres compris", () => {
    expect(safeReturnPath("/logements/p1?tab=calendrier")).toBe("/logements/p1?tab=calendrier");
    expect(safeReturnPath("/glossaire#adr")).toBe("/glossaire#adr");
    expect(safeReturnPath("/alertes?_rsc=abc")).toBe("/alertes");
  });
  it("renvoie à l'accueil tout ce qui pourrait sortir de l'application ou boucler", () => {
    for (const raw of [null, undefined, "", "alertes", "https://exemple.test/", "//exemple.test", "/\\exemple.test", "\\\\exemple.test", "/\t/exemple.test", "/\n/exemple.test",
      "javascript:alert(1)", "/..//exemple.test", "/.//exemple.test", "/a/..//exemple.test", "/%2e%2e//exemple.test", "/vue", "/vue?mode=poche", "/vue/", "/" + "a".repeat(3000)]) {
      expect(safeReturnPath(raw), String(raw)).toBe("/");
    }
    // un hôte encodé reste un simple chemin de l'application
    expect(safeReturnPath("/%2F%2Fexemple.test")).toBe("/%2F%2Fexemple.test");
  });
});

describe("contexte d'une page", () => {
  const ctx = (path: string, cookies: Record<string, string> = {}, ua = UA.iphone) => viewContext(h({ "user-agent": ua, [PATH_HEADER]: path }), (n) => cookies[n]);
  it("bloque un écran réservé à l'ordinateur en mode poche seulement", () => {
    expect(ctx("/modeles/cles").blocked?.section).toBe("IA & modèles");
    expect(ctx("/modeles/cles", {}, UA.bureau).blocked).toBeNull();
    expect(ctx("/modeles/cles", { [VIEW_COOKIE]: "complet" }).blocked).toBeNull();
    expect(ctx("/alertes").blocked).toBeNull();
  });
  it("respecte « Afficher quand même » pour cet écran seulement", () => {
    const cookies = { [FORCE_COOKIE]: "/logements/p1?rubrique=economie,creation" };
    expect(ctx("/logements/p1/couts?x=1", cookies).blocked).toBeNull();
    expect(ctx("/logements/p2/couts", cookies).blocked).not.toBeNull();
    expect(ctx("/logements/nouveau", cookies).blocked).toBeNull();
    expect(ctx("/logements/p9/creation?etape=couts", cookies).blocked).toBeNull();
  });
  it("bloque aussi quand les paramètres sont refusés comme adresse de retour", () => {
    for (const q of [`x=${"a".repeat(2100)}`, "x=\\"]) {
      const c = ctx(`/bilan?${q}`);
      expect(c.blocked, q.slice(0, 20)).not.toBeNull();
      expect(c).toMatchObject({ pathname: "/bilan", current: "/bilan" });
    }
  });
  it("réserve une rubrique de la fiche d'après son onglet, et retient le choix pour toute la rubrique", () => {
    expect(ctx("/logements/p1").blocked).toBeNull();
    expect(ctx("/logements/p1?tab=performance").blocked).toBeNull();
    expect(ctx("/logements/p1?tab=pricelabs").blocked).toMatchObject({ section: "Données & connexions", back: "/logements/p1" });
    const key = ctx("/logements/p1?tab=hub-donnees").blocked!.key;
    expect(ctx("/logements/p1?tab=pricelabs", { [FORCE_COOKIE]: key }).blocked).toBeNull();
    expect(ctx("/logements/p1?tab=calendrier", { [FORCE_COOKIE]: key }).blocked).not.toBeNull();
    // paramètres refusés comme adresse de retour : l'onglet reste lu
    expect(ctx(`/logements/p1?tab=calendrier&x=${"a".repeat(2100)}`).blocked).not.toBeNull();
    expect(ctx("/logements/p1?tab=calendrier", {}, UA.bureau).blocked).toBeNull();
  });
  it("sans en-tête de chemin, rien n'est bloqué et le retour mène à l'accueil", () => {
    const c = viewContext(h({ "user-agent": UA.iphone }), () => undefined);
    expect(c).toMatchObject({ mode: "poche", phone: true, current: "/", blocked: null });
  });
});

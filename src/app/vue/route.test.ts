import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedInReadonly } from "@/lib/demo-mode";
import { PATH_HEADER } from "@/lib/nav";
import { proxy } from "@/proxy";
import { GET } from "./route";

const call = (query: string, cookie?: string) => GET(new NextRequest(`http://0.0.0.0:3000/vue${query}`, cookie ? { headers: { cookie } } : undefined));
afterEach(() => vi.unstubAllEnvs());

describe("GET /vue", () => {
  it("pose le mode pour un an et revient à la page, en adresse relative", () => {
    const r = call("?mode=complet&retour=%2Flogements%2Fp1%3Ftab%3Dcalendrier");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/logements/p1?tab=calendrier");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.cookies.get("ns_vue")).toMatchObject({ value: "complet", maxAge: 31_536_000, sameSite: "lax", path: "/", httpOnly: true });
    expect(r.cookies.get("ns_vue_force")).toBeUndefined();
  });
  it("marque les cookies « secure » quand l'application est en https", () => {
    vi.stubEnv("APP_URL", "https://nuit-signal.example.test");
    expect(call("?mode=poche").cookies.get("ns_vue")?.secure).toBe(true);
  });
  it("ignore un mode inconnu et refuse de rediriger ailleurs", () => {
    const r = call("?mode=complete&retour=https%3A%2F%2Fexemple.test");
    expect(r.headers.get("location")).toBe("/");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(call("?mode=poche&retour=%2F%2Fexemple.test").headers.get("location")).toBe("/");
    expect(call("?mode=poche").headers.get("location")).toBe("/");
  });
  it("retient « Afficher quand même » dans un cookie de session, en plus des choix précédents", () => {
    const r = call("?afficher=%2Fmodeles%2Fcles&retour=%2Fmodeles%2Fcles", "ns_vue_force=creation");
    const c = r.cookies.get("ns_vue_force")!;
    expect(c.value).toBe("creation,/modeles/cles");
    expect(c.maxAge).toBeUndefined();
    expect(c.expires).toBeUndefined();
  });
  it("n'enregistre rien pour un écran qui n'est pas réservé à l'ordinateur", () => {
    expect(call("?afficher=%2Falertes").headers.get("set-cookie")).toBeNull();
    expect(call("?afficher=https%3A%2F%2Fexemple.test%2Fbilan").headers.get("set-cookie")).toBeNull();
  });
});

describe("proxy", () => {
  it("laisse passer la bascule sur la démo en lecture seule", () => {
    expect(blockedInReadonly("GET", "/vue")).toBe(false);
    vi.stubEnv("DEMO_READONLY", "true");
    expect(proxy(new NextRequest("http://demo.test/vue?mode=complet")).status).toBe(200);
    expect(proxy(new NextRequest("http://demo.test/alertes", { method: "POST" })).status).toBe(403);
  });
  it("demande l'indice « mobile » et transmet le chemin, sans croire le navigateur", () => {
    const r = proxy(new NextRequest("http://app.test/logements/p1?tab=economie", { headers: { [PATH_HEADER]: "/faux" } }));
    expect(r.headers.get("accept-ch")).toBe("Sec-CH-UA-Mobile");
    expect(r.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe("/logements/p1?tab=economie");
  });
});

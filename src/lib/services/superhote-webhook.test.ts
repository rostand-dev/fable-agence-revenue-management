import { afterEach, describe, expect, it } from "vitest";
import { publicWebhookUrl, tokenFingerprint, webhookBaseUrl } from "./superhote-webhook";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("adresse publique des webhooks", () => {
  it("SUPERHOTE_WEBHOOK_BASE_URL prime sur APP_URL ; l'adresse est normalisée", () => {
    process.env.APP_URL = "https://app.exemple.fr/"; process.env.SUPERHOTE_WEBHOOK_BASE_URL = "";
    expect(webhookBaseUrl()).toBe("https://app.exemple.fr");
    process.env.SUPERHOTE_WEBHOOK_BASE_URL = "https://hooks.exemple.fr/chemin/";
    expect(webhookBaseUrl()).toBe("https://hooks.exemple.fr");
    expect(publicWebhookUrl("whk_1")).toEqual({ url: "https://hooks.exemple.fr/api/webhooks/superhote/whk_1" });
  });
  it("refuse une adresse absente, illisible, en http ou privée, avec un message exploitable", () => {
    for (const v of ["", "pas une url", "http://app.exemple.fr", "https://localhost:3000", "https://127.0.0.1", "https://10.1.2.3", "https://192.168.0.4", "https://172.20.0.1", "https://e2e.nuit-signal.test:3000", "https://monpc.local", "https://[::1]"]) {
      process.env.APP_URL = v; process.env.SUPERHOTE_WEBHOOK_BASE_URL = "";
      const r = publicWebhookUrl("whk_1");
      expect("error" in r, v).toBe(true);
    }
    process.env.APP_URL = "https://172.32.0.1"; expect("url" in publicWebhookUrl("w")).toBe(true); // hors plage privée 172.16-31
  });
});

describe("empreinte du jeton", () => {
  it("stable, distincte par jeton, indépendante du jeton en clair, et exige APP_SECRET", () => {
    process.env.APP_SECRET = "un-secret-assez-long-0123456789";
    const a = tokenFingerprint("tok-aaaaaaaaaaaaaaaaaaaa"), b = tokenFingerprint("tok-bbbbbbbbbbbbbbbbbbbb");
    expect(a).toBe(tokenFingerprint("tok-aaaaaaaaaaaaaaaaaaaa"));
    expect(a).not.toBe(b);
    expect(a).not.toContain("tok-aaaa");
    process.env.APP_SECRET = "";
    expect(() => tokenFingerprint("tok-aaaaaaaaaaaaaaaaaaaa")).toThrow(/APP_SECRET/);
  });
});

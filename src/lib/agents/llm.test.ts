import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callLlm, listAnthropicModels, LlmError } from "./llm";
import { effectiveModel, pickLlmConfig } from "./llm-config";
import { decryptSecret, encryptSecret, secretHint } from "../secret";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); delete process.env.ANTHROPIC_API_BASE; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("listAnthropicModels", () => {
  it("lit la liste avec la clé de l'utilisateur et suit la pagination", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: "claude-a", display_name: "Claude A", created_at: "2026-01-01T00:00:00Z" }], has_more: true, last_id: "claude-a" }))
      .mockResolvedValueOnce(json({ data: [{ id: "claude-b", display_name: "Claude B", created_at: "2026-02-01T00:00:00Z" }], has_more: false, last_id: "claude-b" }));
    const models = await listAnthropicModels("sk-ant-test-key-0123456789");
    expect(models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(models[0].name).toBe("Claude A");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test-key-0123456789");
    expect(String(fetchMock.mock.calls[1][0])).toContain("after_id=claude-a");
  });
  it("utilise ANTHROPIC_API_BASE quand elle est définie", async () => {
    process.env.ANTHROPIC_API_BASE = "http://localhost:9999/";
    fetchMock.mockResolvedValueOnce(json({ data: [], has_more: false }));
    await listAnthropicModels("k".repeat(20));
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://localhost:9999/v1/models?limit=100");
  });
  it.each([[401, "refusée"], [403, "Accès refusé"], [429, "Trop de requêtes"], [500, "HTTP 500"]])("traduit l'erreur %i en message clair", async (status, part) => {
    fetchMock.mockResolvedValueOnce(json({ error: {} }, status));
    await expect(listAnthropicModels("k".repeat(20))).rejects.toThrow(part);
  });
  it("signale un fournisseur injoignable sans fuite de la clé", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed sk-ant-secret"));
    const err = await listAnthropicModels("sk-ant-secret-0123456789").catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).not.toContain("sk-ant");
  });
});

describe("callLlm", () => {
  it("envoie le modèle et la clé résolus pour l'agent", async () => {
    fetchMock.mockResolvedValueOnce(json({ content: [{ type: "text", text: " Bonjour " }], usage: { input_tokens: 5, output_tokens: 2 } }));
    const r = await callLlm({ apiKey: "sk-ant-user-0123456789", model: "claude-choisi", source: "utilisateur" }, { system: "s", messages: [{ role: "user", content: "q" }] });
    expect(r.text).toBe("Bonjour");
    expect(r.model).toBe("claude-choisi");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).model).toBe("claude-choisi");
    expect(init.headers["x-api-key"]).toBe("sk-ant-user-0123456789");
  });
  it("renvoie une erreur claire si le modèle n'existe plus (404)", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(callLlm({ apiKey: "k".repeat(20), model: "retire", source: "utilisateur" }, { system: "s", messages: [{ role: "user", content: "q" }] })).rejects.toThrow("Modèle introuvable");
  });
});

describe("pickLlmConfig", () => {
  const base = { serverKey: undefined as string | undefined, defaultModel: "defaut" };
  it("clé utilisateur + modèle choisi", () => expect(pickLlmConfig({ ...base, userKey: "u", agentModel: "m" })).toEqual({ apiKey: "u", model: "m", source: "utilisateur" }));
  it("clé utilisateur sans choix : modèle par défaut", () => expect(pickLlmConfig({ ...base, userKey: "u", agentModel: undefined })?.model).toBe("defaut"));
  it("sans clé utilisateur : clé du serveur, et le choix de modèle est ignoré", () => expect(pickLlmConfig({ ...base, userKey: null, serverKey: "s", agentModel: "m" })).toEqual({ apiKey: "s", model: "defaut", source: "serveur" }));
  it("aucune clé : repli déterministe", () => expect(pickLlmConfig({ ...base, userKey: null, agentModel: "m" })).toBeNull());
});

describe("effectiveModel", () => {
  it("couvre les trois sources", () => {
    expect(effectiveModel("aucune", "m", "d")).toBeNull();
    expect(effectiveModel("serveur", "m", "d")).toBe("d");
    expect(effectiveModel("utilisateur", "m", "d")).toBe("m");
    expect(effectiveModel("utilisateur", undefined, "d")).toBe("d");
  });
});

describe("secret", () => {
  it("chiffre puis déchiffre, et n'expose que les 4 derniers caractères", () => {
    process.env.APP_SECRET = "un-secret-de-test-assez-long";
    const key = "sk-ant-api03-abcdefghijklmnop";
    const enc = encryptSecret(key);
    expect(enc).not.toContain(key);
    expect(decryptSecret(enc)).toBe(key);
    expect(secretHint(key)).toBe("••••mnop");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
vi.mock("@/lib/auth", () => ({ getUser: () => getUser() }));
vi.mock("@/lib/agents/llm", () => ({ streamLlm: vi.fn() }));
vi.mock("@/lib/services/chat", () => ({ CHAT_MAX_TOKENS: 1, prepareChat: vi.fn(), finishChat: vi.fn() }));

import { prepareChat } from "@/lib/services/chat";
import { POST } from "./route";

// Question vide : une requête qui passe le contrôle d'origine s'arrête là (400), sans rien appeler.
const ask = (headers: Record<string, string>) => POST(new Request("http://app.test/api/chat", { method: "POST", headers: { host: "app.test", "content-type": "application/json", ...headers }, body: "{}" }));

describe("POST /api/chat : contrôle d'origine, comme les autres routes", () => {
  beforeEach(() => { getUser.mockResolvedValue({ id: "u1", tenantId: "t1", role: "OWNER" }); });

  it.each(["https://ailleurs.example", "null", "pas une adresse"])("refuse l'origine « %s » sans erreur technique", async (origin) => {
    const res = await ask({ origin });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Requête refusée." });
    expect(prepareChat).not.toHaveBeenCalled();
  });

  it("accepte la même origine, ou aucune", async () => {
    expect((await ask({ origin: "http://app.test" })).status).toBe(400);
    expect((await ask({})).status).toBe(400);
  });

  it("derrière un proxy, compare à l'hôte transmis", async () => {
    expect((await ask({ origin: "https://public.test", host: "interne:3000", "x-forwarded-host": "public.test" })).status).toBe(400);
  });

  it("sans session : 401 avant tout", async () => {
    getUser.mockResolvedValue(null);
    expect((await ask({ origin: "null" })).status).toBe(401);
  });
});

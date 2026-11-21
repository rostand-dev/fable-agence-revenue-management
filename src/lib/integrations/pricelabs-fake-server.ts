import http from "node:http";
import { todayISO, type ISODate } from "../dates";
import { buildScenario, isScenarioName, type Endpoint, type Scenario, type ScenarioName } from "./pricelabs-scenarios";

/**
 * Faux serveur HTTP de l'API client PriceLabs (US-044), pour les tests de bout en bout : l'application, lancée avec
 * `PRICELABS_API_BASE=http://127.0.0.1:4010/v1`, lit ce serveur exactement comme elle lirait PriceLabs (même chemins, mêmes formes de réponse).
 *
 * Le scénario est choisi par la CLÉ API saisie : `fake-<scénario>-<suffixe>` (ex. `fake-nominal-abc123…`, `fake-toggle-off-…`).
 * Ainsi chaque test choisit son cas sans état partagé, et des tests parallèles ne se gênent pas : le suffixe rend aussi l'identifiant de l'annonce unique (fake-1001-<suffixe>). Toute autre clé est refusée (401).
 * Seules les lectures existent ; tout autre appel est refusé (404 ou 405) ET consigné comme tentative d'écriture : `/__calls` permet de prouver qu'aucune n'a eu lieu.
 */
export type RecordedCall = { method: string; path: string; scenario: string | null; status: number; write: boolean };
export type FakeServer = { url: string; port: number; calls: RecordedCall[]; close: () => Promise<void> };

const KEY = /^fake-([a-z-]+?)-[A-Za-z0-9]{6,}$/;
/** Scénario et suffixe d'identifiant d'une clé ; le suffixe est la fin de la clé (unique par clé). */
const parseKey = (key: string | undefined): { name: ScenarioName; suffix: string } | null => {
  const m = key ? KEY.exec(key) : null;
  return m && isScenarioName(m[1]) ? { name: m[1], suffix: key!.slice(key!.lastIndexOf("-") + 1) } : null;
};

export async function startFakePriceLabsServer(opts: { port?: number; host?: string; now?: () => Date } = {}): Promise<FakeServer> {
  const now = opts.now ?? (() => new Date());
  const calls: RecordedCall[] = [];
  const flakyCount = new Map<string, number>();
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.local");
    const method = req.method ?? "GET", path = url.pathname.replace(/^\/v1(?=\/)/, "");
    // sondes du banc d'essai : ne comptent pas comme des appels à PriceLabs
    if (path === "/__health") return json(res, 200, { ok: true });
    if (path === "/__calls") { if (method === "DELETE") calls.length = 0; return json(res, 200, calls); }

    const key = String(req.headers["x-api-key"] ?? ""), parsed = parseKey(key), name = parsed?.name ?? null;
    const record = (status: number, write = false) => calls.push({ method, path, scenario: name, status, write });
    const endpoint: Endpoint | null = path === "/listings" && method === "GET" ? "listings" : path === "/listing_prices" && method === "POST" ? "prices" : path === "/neighborhood_data" && method === "GET" ? "neighborhood" : path === "/reservation_data" && method === "GET" ? "reservations" : null;
    if (!endpoint) { const status = ["GET", "POST"].includes(method) ? 404 : 405; record(status, true); return json(res, status, { error: "Point d'accès inconnu ou en écriture : refusé par le faux serveur." }); }
    if (!name) { record(401); return json(res, 401, { error: "Clé API inconnue du faux serveur (format fake-<scénario>-<suffixe>)." }); }

    const today: ISODate = todayISO(now()), sc: Scenario = buildScenario(parsed!.name, today, { idSuffix: parsed!.suffix });
    const hard = sc.failures?.[endpoint];
    if (hard) { record(hard); return json(res, hard, { error: "Échec simulé." }); }
    const flaky = sc.flaky?.[endpoint];
    if (flaky) {
      const k = `${key}|${endpoint}`, n = flakyCount.get(k) ?? 0;
      if (n < flaky.times) { flakyCount.set(k, n + 1); record(flaky.status); return json(res, flaky.status, { error: "Panne passagère simulée." }); }
    }

    if (endpoint === "listings") { record(200); return json(res, 200, { listings: sc.listings }); }
    if (endpoint === "prices") {
      let body: any = {};
      try { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { record(400); return json(res, 400, { error: "Corps illisible." }); }
      const asked: any[] = Array.isArray(body.listings) ? body.listings : [];
      record(200);
      return json(res, 200, asked.map((a) => {
        const item = sc.prices[String(a.id)];
        if (!item) return { id: a.id, pms: a.pms, error: "Listing not found", error_status: "LISTING_NOT_PRESENT" };
        return item.data ? { ...item, data: item.data.filter((d: any) => (!a.dateFrom || d.date >= a.dateFrom) && (!a.dateTo || d.date <= a.dateTo)) } : item;
      }));
    }
    const id = url.searchParams.get("listing_id") ?? "";
    if (endpoint === "neighborhood") { record(200); return json(res, 200, { data: sc.neighborhood[id] ?? null }); }
    const from = url.searchParams.get("start_date") ?? "0000-00-00", to = url.searchParams.get("end_date") ?? "9999-99-99";
    const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 100) || 100), offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const all = (sc.reservations[id] ?? []).filter((r) => String(r.check_in).slice(0, 10) >= from && String(r.check_in).slice(0, 10) <= to);
    record(200);
    return json(res, 200, { data: all.slice(offset, offset + limit), next_page: offset + limit < all.length });
  });

  await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", ok); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://${opts.host ?? "127.0.0.1"}:${port}/v1`, port, calls, close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}

import http from "node:http";
import { todayISO, type ISODate } from "../dates";
import { buildScenario, isScenarioName, type Endpoint, type Scenario, type ScenarioName } from "./pricelabs-scenarios";

/**
 * Faux serveur HTTP de l'API client PriceLabs (US-044), pour les tests de bout en bout : l'application, lancée avec
 * `PRICELABS_API_BASE=http://127.0.0.1:4010/v1`, lit ce serveur exactement comme elle lirait PriceLabs (même chemins, mêmes formes de réponse).
 *
 * Le scénario est choisi par la CLÉ API saisie : `fake-<scénario>-<suffixe>` (ex. `fake-nominal-abc123…`, `fake-toggle-off-…`).
 * Ainsi chaque test choisit son cas sans état partagé, et des tests parallèles ne se gênent pas : le suffixe rend aussi l'identifiant de l'annonce unique (fake-1001-<suffixe>). Toute autre clé est refusée (401).
 * Lectures : annonces, grille, marché, réservations, prix datés. Écritures (épic 9) : `POST /listings` (min/base/max) et `POST`/`DELETE /listings/{id}/overrides`,
 * gardées en mémoire PAR CLÉ (une relecture les voit, comme chez PriceLabs) et consignées avec `write: true` : `/__calls` permet de prouver qu'aucune écriture n'a eu lieu
 * (ou laquelle a eu lieu). Tout autre appel est refusé (404 ou 405) ET consigné comme tentative d'écriture.
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
  // état des écritures, par clé API : limites (en unités de l'API) et dérogations (forme brute)
  const limitsByKey = new Map<string, Map<string, { min?: number; base?: number; max?: number }>>();
  const dsoByKey = new Map<string, Map<string, Map<string, any>>>();
  const mapOf = <T,>(m: Map<string, Map<string, T>>, key: string) => { let x = m.get(key); if (!x) m.set(key, (x = new Map())); return x; };
  const readBody = async (req: http.IncomingMessage): Promise<any> => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); };
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.local");
    const method = req.method ?? "GET", path = url.pathname.replace(/^\/v1(?=\/)/, "");
    // sondes du banc d'essai : ne comptent pas comme des appels à PriceLabs
    if (path === "/__health") return json(res, 200, { ok: true });
    if (path === "/__calls") { if (method === "DELETE") calls.length = 0; return json(res, 200, calls); }

    const key = String(req.headers["x-api-key"] ?? ""), parsed = parseKey(key), name = parsed?.name ?? null;
    const record = (status: number, write = false) => calls.push({ method, path, scenario: name, status, write });
    const ov = /^\/listings\/([^/]+)\/overrides$/.exec(path);
    const isWrite = (path === "/listings" && method === "POST") || (!!ov && (method === "POST" || method === "DELETE"));
    const isOvRead = !!ov && method === "GET";
    const endpoint: Endpoint | null = isWrite ? "write" : isOvRead ? "listings" : path === "/listings" && method === "GET" ? "listings" : path === "/listing_prices" && method === "POST" ? "prices" : path === "/neighborhood_data" && method === "GET" ? "neighborhood" : path === "/reservation_data" && method === "GET" ? "reservations" : null;
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

    if (isWrite) {
      let body: any;
      try { body = await readBody(req); } catch { record(400, true); return json(res, 400, { error: "Corps illisible." }); }
      const knownIds = new Set(sc.listings.map((l: any) => String(l.id)));
      if (path === "/listings") {
        const asked: any[] = Array.isArray(body.listings) ? body.listings : [];
        if (!asked.length || asked.some((a) => !a?.id || !a?.pms || !knownIds.has(String(a.id)) || ["min", "base", "max"].some((k) => a[k] !== undefined && !(typeof a[k] === "number" && a[k] > 0)))) { record(400, true); return json(res, 400, { error: "Requête invalide : annonce inconnue ou valeur non positive." }); }
        for (const a of asked) { const m = mapOf(limitsByKey, key), cur = m.get(String(a.id)) ?? {}; for (const k of ["min", "base", "max"] as const) if (a[k] !== undefined) cur[k] = a[k]; m.set(String(a.id), cur); }
        record(200, true); return json(res, 200, { listings: asked.map((a) => ({ id: a.id, pms: a.pms })) });
      }
      const lid = decodeURIComponent(ov![1]);
      if (!knownIds.has(lid)) { record(404, true); return json(res, 404, { error: "Annonce inconnue." }); }
      const list: any[] = Array.isArray(body.overrides) ? body.overrides : [];
      const bad = !body.pms || !list.length || list.some((o) => !/^\d{4}-\d{2}-\d{2}$/.test(String(o?.date ?? "")) || (method === "POST" && (!["fixed", "percent"].includes(String(o?.price_type ?? "fixed")) || !Number.isFinite(Number(o?.price ?? NaN)) || (String(o?.price_type ?? "fixed") === "fixed" ? Number(o.price) <= 0 : false))));
      if (bad) { record(400, true); return json(res, 400, { error: "Requête invalide : aucune dérogation n'est enregistrée." }); }
      const store = mapOf(dsoByKey, key), dates = store.get(lid) ?? new Map<string, any>();
      store.set(lid, dates);
      if (method === "DELETE") { for (const o of list) dates.delete(String(o.date)); record(204, true); res.writeHead(204); return void res.end(); }
      for (const o of list) dates.set(String(o.date), { ...o });
      record(200, true); return json(res, 200, { overrides: list, child_listings_update_info: {} });
    }
    if (isOvRead) {
      const lid = decodeURIComponent(ov![1]), from = url.searchParams.get("start_date") ?? "0000-00-00", to = url.searchParams.get("end_date") ?? "9999-99-99";
      if (!sc.listings.some((l: any) => String(l.id) === lid)) { record(404); return json(res, 404, { error: "Annonce inconnue." }); }
      record(200);
      return json(res, 200, { overrides: [...(dsoByKey.get(key)?.get(lid)?.values() ?? [])].filter((o: any) => o.date >= from && o.date <= to).sort((a: any, b: any) => a.date.localeCompare(b.date)).map((o: any) => ({ ...o, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" })) });
    }
    if (endpoint === "listings") {
      const mine = limitsByKey.get(key);
      record(200);
      return json(res, 200, { listings: sc.listings.map((l: any) => (mine?.get(String(l.id)) ? { ...l, ...mine.get(String(l.id)) } : l)) });
    }
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

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listReservations } from "./superhote";

// Une lecture incomplète est une erreur : la réconciliation annule ce qui est absent d'une lecture COMPLÈTE.
let server: http.Server, mode: "full" | "endless" | "nometa-full" | "nometa-short" = "full"; const asked: number[] = [];
const item = (i: number) => ({ id: i, rental_id: 7, checkin: "2026-12-01", checkout: "2026-12-03", nights: 2 });
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x"), page = Number(u.searchParams.get("page")); asked.push(page);
    const n = (k: number) => Array.from({ length: k }, (_, i) => item(page * 1000 + i));
    const body = mode === "full" ? { result: { items: page === 3 ? n(5) : n(100), meta: { last_page: 3 } } }
      : mode === "endless" ? { result: { items: n(100), meta: { last_page: 99 } } }
      : mode === "nometa-full" ? { result: { items: page === 2 ? n(10) : n(100) } }
      : { result: { items: n(40) } };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SUPERHOTE_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

describe("lecture paginée des réservations", () => {
  it("lit toutes les pages annoncées", async () => { mode = "full"; asked.length = 0; expect(await listReservations("tok", "7")).toHaveLength(205); expect(asked).toEqual([1, 2, 3]); });
  it("sans méta, une page pleine annonce une suite ; une page courte termine", async () => { mode = "nometa-full"; asked.length = 0; expect(await listReservations("tok", "7")).toHaveLength(110); expect(asked).toEqual([1, 2]); mode = "nometa-short"; expect(await listReservations("tok", "7")).toHaveLength(40); });
  it("au-delà du plafond de pages : erreur explicite, jamais une lecture partielle", async () => { mode = "endless"; await expect(listReservations("tok", "7")).rejects.toThrow(/incomplète/); });
});

import { apiUser, apiWriter, fromError, isResponse, json, listingView, readObject } from "@/lib/api/v1";
import { createListing, listListings } from "@/lib/services/portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const u = await apiUser(); if (isResponse(u)) return u;
  try { return json({ listings: (await listListings(u.tenantId, (await params).id)).map(listingView) }); } catch (e) { return fromError(e); }
}
/** POST : { channel: AIRBNB | BOOKING | DIRECT, externalId?, url?, title? } */
export async function POST(req: Request, { params }: Ctx) {
  const u = await apiWriter(req, "property.manage", (await params).id); if (isResponse(u)) return u;
  const body = await readObject(req); if (isResponse(body)) return body;
  try { return json({ id: await createListing(u, (await params).id, body) }, 201); } catch (e) { return fromError(e); }
}

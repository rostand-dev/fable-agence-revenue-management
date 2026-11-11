/** Dates manipulées en chaînes ISO (AAAA-MM-JJ), sans heure, pour éviter les dérives de fuseau. */
export type ISODate = string;
const DAY = 86400000;

export function todayISO(now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function toUTC(d: ISODate): number { return Date.parse(d + "T00:00:00Z"); }
export function addDays(d: ISODate, n: number): ISODate { return new Date(toUTC(d) + n * DAY).toISOString().slice(0, 10); }
export function diffDays(a: ISODate, b: ISODate): number { return Math.round((toUTC(a) - toUTC(b)) / DAY); }
export function dow(d: ISODate): number { return new Date(toUTC(d)).getUTCDay(); }
export function monthKey(d: ISODate): string { return d.slice(0, 7); }
export function daysInMonth(key: string): number { const [y, m] = key.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function range(from: ISODate, to: ISODate): ISODate[] { const out: ISODate[] = []; for (let d = from; d < to; d = addDays(d, 1)) out.push(d); return out; }

const fShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const fLong = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fMonth = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const fMonthShort = new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" });
const fDT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
export const fmtDay = (d: ISODate) => fShort.format(new Date(toUTC(d)));
export const fmtDate = (d: ISODate) => fLong.format(new Date(toUTC(d)));
export const fmtMonth = (key: string) => fMonth.format(new Date(toUTC(key + "-01")));
export const fmtMonthShort = (key: string) => fMonthShort.format(new Date(toUTC(key + "-01")));
export const fmtDateTime = (d: Date) => fDT.format(d).replace(" à ", " · ");
/** Période de séjour : nuits du `from` inclus au `to` exclu. */
export function fmtPeriod(from: ISODate, to: ISODate): string {
  const n = diffDays(to, from);
  return `${fmtDay(from)} → ${fmtDate(to)} · ${n} nuit${n > 1 ? "s" : ""}`;
}

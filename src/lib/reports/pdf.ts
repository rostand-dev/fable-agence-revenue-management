/**
 * Générateur PDF minimal, sans dépendance (US-113). Module pur : du texte en Helvetica (police standard, aucune police embarquée),
 * titres, paragraphes, lignes « libellé : valeur », saut de page automatique, A4, accents français et symbole € (WinAnsi).
 * Les caractères hors WinAnsi sont remplacés par « ? » plutôt que de produire un fichier illisible.
 */
export type Block = { kind: "title" | "heading" | "para" | "small"; text: string } | { kind: "row"; label: string; value: string } | { kind: "space" };

// Largeurs Helvetica (millièmes d'em) pour ASCII 32..126 ; autres caractères : 556.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const SIZE: Record<string, number> = { title: 18, heading: 13, para: 10.5, small: 9, row: 10.5 };
const LEAD = 1.35, PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 50;

const WIN1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
/** Octet WinAnsi d'un caractère, ou « ? ». Les espaces insécables deviennent des espaces, le signe moins typographique un tiret. */
export function winAnsi(ch: string): number {
  if (ch === " " || ch === " " || ch === " ") return 0x20;
  if (ch === "−") return 0x2d;
  if (ch === "\n" || ch === "\t") return 0x20;
  const c = ch.codePointAt(0)!;
  if (c >= 0x20 && c <= 0x7e) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return WIN1252[ch] ?? 0x3f;
}
const WIDE: Record<string, number> = { "—": 1000, "…": 1000, "–": 556, "‰": 1000, "™": 1000, "œ": 889, "Œ": 1000, "æ": 889, "Æ": 1000 };
/** Largeur d'un caractère (millièmes d'em) : ASCII d'après la table, accentués d'après leur lettre de base, quelques signes larges. */
const glyph = (ch: string): number => {
  if (WIDE[ch]) return WIDE[ch];
  const b = winAnsi(ch);
  if (b >= 32 && b <= 126) return W[b - 32];
  const base = ch.normalize("NFD")[0];
  const bb = base ? winAnsi(base) : 0x3f;
  return bb >= 32 && bb <= 126 ? W[bb - 32] : 556;
};
const width = (t: string, size: number) => { let w = 0; for (const ch of t) w += glyph(ch) * size / 1000; return w; };
const esc = (t: string) => { let o = ""; for (const ch of t) { const b = winAnsi(ch); o += b === 0x28 || b === 0x29 || b === 0x5c ? "\\" + String.fromCharCode(b) : b < 0x20 || b > 0x7e ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b); } return o; };

/** Coupe un texte en lignes qui tiennent dans la largeur ; un mot plus long que la ligne est coupé. */
export function wrap(text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (width(word, size) > maxW) {
        let cut = word.length; while (cut > 1 && width(word.slice(0, cut), size) > maxW) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, cut)); word = word.slice(cut);
      }
      const next = line ? line + " " + word : word;
      if (width(next, size) <= maxW) line = next; else { if (line) out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

export function buildPdf(blocks: Block[], meta: { title: string; footer?: string }): Buffer {
  type Line = { text: string; size: number; bold: boolean; x: number; gap: number };
  const pages: Line[][] = [[]];
  let y = PAGE_H - MARGIN;
  const place = (lines: string[], size: number, bold: boolean, x: number, gapBefore: number) => {
    lines.forEach((text, i) => {
      const step = size * LEAD;
      if (y - step < MARGIN + 20) { pages.push([]); y = PAGE_H - MARGIN; }
      y -= step + (i === 0 ? gapBefore : 0);
      pages[pages.length - 1].push({ text, size, bold, x, gap: y });
    });
  };
  const inner = PAGE_W - 2 * MARGIN;
  for (const b of blocks) {
    if (b.kind === "space") { y -= 8; continue; }
    if (b.kind === "row") {
      const labelW = 170, vl = wrap(b.value, SIZE.row, inner - labelW), ll = wrap(b.label, SIZE.row, labelW - 8);
      const n = Math.max(vl.length, ll.length);
      for (let i = 0; i < n; i++) {
        const step = SIZE.row * LEAD;
        if (y - step < MARGIN + 20) { pages.push([]); y = PAGE_H - MARGIN; }
        y -= step;
        if (ll[i] !== undefined) pages[pages.length - 1].push({ text: ll[i], size: SIZE.row, bold: true, x: MARGIN, gap: y });
        if (vl[i] !== undefined) pages[pages.length - 1].push({ text: vl[i], size: SIZE.row, bold: false, x: MARGIN + labelW, gap: y });
      }
      continue;
    }
    const size = SIZE[b.kind], bold = b.kind === "title" || b.kind === "heading";
    place(wrap(b.text, size, inner), size, bold, MARGIN, b.kind === "heading" ? 10 : b.kind === "para" ? 4 : 0);
  }
  // objets : 1 catalogue, 2 pages, 3 police, 4 police grasse, puis (page, contenu) par page
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    const foot = `${meta.footer ? meta.footer + " · " : ""}page ${i + 1} sur ${pages.length}`;
    const body = lines.map((l) => `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf ${l.x.toFixed(2)} ${l.gap.toFixed(2)} Td (${esc(l.text)}) Tj ET`).join("\n") + `\nBT /F1 8 Tf ${MARGIN} 30 Td (${esc(foot)}) Tj ET`;
    objs[5 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`;
    objs[6 + 2 * i] = `<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`;
  });
  const info = objs.length; objs[info] = `<< /Title (${esc(meta.title)}) /Producer (NuitSignal) >>`;
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) { offsets[i] = pos; const b = Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, "latin1"); parts.push(b); pos += b.length; }
  const xref = [`xref\n0 ${objs.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

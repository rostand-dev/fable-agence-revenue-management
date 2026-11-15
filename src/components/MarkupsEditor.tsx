"use client";
import { useState } from "react";
import { Icon } from "./Icon";
import type { ChannelMarkup } from "@/lib/pricing/published";

const SUGGESTIONS = ["Airbnb", "Booking", "Direct"];
type Row = { id: number; label: string; pct: string };
const show = (p: number | null) => (p === null ? "" : String(p).replace(".", ","));

/**
 * Majorations SuperHote par canal. Une ligne = un canal ; pourcentage vide = inconnu (jamais 0 %).
 * Les champs partent avec le formulaire sous forme de listes parallèles `markupLabel` / `markupPct`.
 */
export function MarkupsEditor({ initial }: { initial: ChannelMarkup[] }) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((m, i) => ({ id: i, label: m.label, pct: show(m.pct) })));
  const [next, setNext] = useState(initial.length);
  const add = (label = "") => { setRows((r) => [...r, { id: next, label, pct: "" }]); setNext((n) => n + 1); };
  const patch = (id: number, k: "label" | "pct", v: string) => setRows((r) => r.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const missing = SUGGESTIONS.filter((s) => !rows.some((r) => r.label.trim().toLowerCase() === s.toLowerCase()));
  return (
    <div className="markups">
      {rows.length === 0 && <p className="muted" style={{ margin: "0 0 10px" }}>Aucun canal pour l'instant : les prix publiés restent inconnus, seul le prix envoyé à SuperHote est affiché.</p>}
      {rows.map((r) => (
        <div className="markup-row" key={r.id}>
          <div className="field">
            <label htmlFor={`mk-l-${r.id}`}>Canal</label>
            <input id={`mk-l-${r.id}`} name="markupLabel" type="text" maxLength={40} value={r.label} onChange={(e) => patch(r.id, "label", e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor={`mk-p-${r.id}`}>Majoration <span className="muted">(%)</span></label>
            <input id={`mk-p-${r.id}`} name="markupPct" type="text" inputMode="decimal" value={r.pct} onChange={(e) => patch(r.id, "pct", e.target.value)} placeholder="inconnue si vide" autoComplete="off" />
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))} aria-label={`Supprimer le canal ${r.label || "sans nom"}`}>Supprimer</button>
        </div>
      ))}
      <div className="row-wrap" style={{ marginTop: 6 }}>
        {missing.map((s) => <button type="button" key={s} className="btn btn-ghost btn-sm" onClick={() => add(s)}><Icon name="plus" />{s}</button>)}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => add()}><Icon name="plus" />Autre canal</button>
      </div>
    </div>
  );
}

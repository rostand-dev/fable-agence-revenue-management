"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, GLOSSARY, GLOSSARY_BY_ID, type GlossaryCategory } from "@/lib/glossary";
import { Icon } from "./Icon";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "'").toLowerCase();
const INDEX = GLOSSARY.map((e) => ({ id: e.id, hay: fold([e.term, ...(e.aka ?? []), e.plain, e.example ?? ""].join(" ")), head: fold([e.term, ...(e.aka ?? [])].join(" ")) }));

export function GlossaryExplorer() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<GlossaryCategory | "all">("all");
  const [target, setTarget] = useState<string | null>(null);

  // arrivée par une infobulle ou un lien : l'entrée ciblée est mise en évidence
  useEffect(() => {
    const read = () => setTarget(decodeURIComponent(window.location.hash.slice(1)) || null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const shown = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    const ok = new Set(INDEX.filter((x) => words.every((w) => x.hay.includes(w))).map((x) => x.id));
    // un terme dont le titre contient la recherche passe devant les simples mentions
    const rank = new Map(INDEX.map((x) => [x.id, words.length && words.every((w) => x.head.includes(w)) ? 0 : 1]));
    return GLOSSARY.filter((e) => ok.has(e.id) && (cat === "all" || e.category === cat)).sort((a, b) => (q ? (rank.get(a.id)! - rank.get(b.id)!) : 0));
  }, [q, cat]);

  const jump = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setQ(""); setCat("all");
    window.history.replaceState(null, "", `#${id}`);
    setTarget(id);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const groups = q ? [{ id: "res", label: `${shown.length} résultat${shown.length > 1 ? "s" : ""}`, intro: "", items: shown }] : CATEGORIES.map((c) => ({ ...c, items: shown.filter((e) => e.category === c.id) })).filter((g) => g.items.length);

  return (
    <div className="gloss">
      <div className="gloss-tools">
        <div className="gloss-search field">
          <label htmlFor="gloss-q" className="visually-hidden">Rechercher un terme</label>
          <span className="gloss-search-icon" aria-hidden="true"><Icon name="search" /></span>
          <input id="gloss-q" type="search" inputMode="search" autoComplete="off" enterKeyHint="search" placeholder="Rechercher : ADR, séjour minimum, plancher…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="filters filters-scroll" role="group" aria-label="Filtrer par thème">
          <button type="button" className="chip" aria-pressed={cat === "all"} onClick={() => setCat("all")}>Tous · {GLOSSARY.length}</button>
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.label}</button>
          ))}
        </div>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{shown.length} terme{shown.length > 1 ? "s" : ""} affiché{shown.length > 1 ? "s" : ""}</p>

      {shown.length === 0 ? (
        <div className="empty">
          <h3>Aucun terme ne correspond</h3>
          <p>Essayez un mot plus court ou retirez le filtre de thème.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(""); setCat("all"); }}>Tout afficher</button>
        </div>
      ) : groups.map((g) => (
        <section className="gloss-group" key={g.id} aria-labelledby={`g-${g.id}`}>
          <h2 id={`g-${g.id}`}>{g.label}</h2>
          {g.intro && <p className="section-note">{g.intro}</p>}
          <div className="gloss-list">
            {g.items.map((e) => (
              <article key={e.id} id={e.id} className={`gloss-entry${target === e.id ? " is-target" : ""}`}>
                <header>
                  <h3>{e.term}</h3>
                  {e.aka && e.aka.length > 0 && <p className="gloss-aka">Aussi appelé : {e.aka.join(" · ")}</p>}
                </header>
                <p className="gloss-plain">{e.plain}</p>
                {e.example && <p className="gloss-example"><span className="gloss-example-k">Exemple concret</span>{e.example}</p>}
                {(e.seeIn || e.related?.length) && (
                  <footer>
                    {e.seeIn && <Link className="gloss-see" href={e.seeIn.href}><Icon name="arrow" size={14} />Voir dans l'application : {e.seeIn.label}</Link>}
                    {e.related && e.related.length > 0 && (
                      <p className="gloss-related"><span>Voir aussi</span>
                        {e.related.filter((r) => GLOSSARY_BY_ID[r]).map((r) => <a key={r} className="chip chip-mini" href={`#${r}`} onClick={(ev) => jump(ev, r)}>{GLOSSARY_BY_ID[r].term}</a>)}
                      </p>
                    )}
                  </footer>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

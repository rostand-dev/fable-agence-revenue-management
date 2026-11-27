import Link from "next/link";
import { inboxHref, SORTS, STATUS_FILTERS, URGENCY_FILTERS, type InboxQuery } from "@/lib/inbox";

/** Filtres de la boîte d'opportunités, communs à la version complète et au mode poche : mêmes champs, mêmes paramètres d'URL. */
export function StatusChips({ q }: { q: InboxQuery }) {
  return (
    <div className="filters" role="group" aria-label="Filtrer par statut">
      {STATUS_FILTERS.map(([k, label]) => <Link key={k} className="chip" href={inboxHref(q, { f: k })} aria-current={q.f === k ? "true" : undefined} scroll={false}>{label}</Link>)}
    </div>
  );
}

/** `reset` : le lien « Réinitialiser » dans le formulaire (le mode poche le place sous les puces). */
export function InboxFilterForm({ q, properties, playbooks, reset }: { q: InboxQuery; properties: { id: string; name: string }[]; playbooks: string[]; reset: boolean }) {
  return (
    <form method="get" action="/" className="inbox-filters" data-testid="inbox-filtres" aria-label="Affiner la liste">
      {q.f !== "a-traiter" && <input type="hidden" name="f" value={q.f} />}
      <label>Logement
        <select name="p" defaultValue={q.p}><option value="">Tous les logements</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      <label>Playbook
        <select name="pb" defaultValue={q.pb}><option value="">Tous les playbooks</option>{playbooks.map((pb) => <option key={pb} value={pb}>{pb}</option>)}</select>
      </label>
      <label>Urgence
        <select name="u" defaultValue={q.u}>{URGENCY_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
      </label>
      <label>Tri
        <select name="s" defaultValue={q.s}>{SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
      </label>
      <div className="inbox-filters-actions">
        <button type="submit" className="btn btn-primary btn-sm">Appliquer</button>
        {reset && <Link className="btn btn-ghost btn-sm" href="/" data-testid="reinitialiser">Réinitialiser</Link>}
      </div>
    </form>
  );
}

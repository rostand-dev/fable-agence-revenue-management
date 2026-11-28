import Link from "next/link";
import { Icon } from "./Icon";

export type TodoItem = { key: string; title: string; body: React.ReactNode; action?: { href: string; label: string } };

/** Carte « À faire » : tout ce qui demande une action sur le logement, avec le lien qui la permet. Rien à faire : pas de carte. */
export function TodoCard({ items, open = true }: { items: TodoItem[]; /** false : carte repliée (fiche de poche) */ open?: boolean }) {
  if (!items.length) return null;
  return (
    <details className="todo-card" open={open} data-testid="todo-card">
      <summary><Icon name="alert" /><span>À faire sur ce logement ({items.length})</span><span className="todo-chevron" aria-hidden="true"><Icon name="caret" /></span></summary>
      <ul>
        {items.map((it) => (
          <li key={it.key} data-testid={`todo-${it.key}`}>
            <p className="todo-title">{it.title}</p>
            <div className="todo-body">{it.body}</div>
            {it.action && <p className="todo-action"><Link className="btn btn-ghost btn-sm" href={it.action.href}>{it.action.label}<Icon name="arrow" /></Link></p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

import Link from "next/link";
import { denyMessage, ROLE_LABEL, rolesWith, type Permission, type Role } from "@/lib/rbac";
import { Icon } from "./Icon";
import { Banner } from "./ui";

/** Écran de saisie que ce rôle ne peut pas utiliser : pourquoi, à qui s'adresser, et où revenir. */
export function Reserved({ role, need, back }: { role: Role; need: Permission; back: { href: string; label: string } }) {
  return (
    <div data-testid="reserve">
      <Banner role="tech" icon="shield" title="Écran réservé" style={{ marginBottom: 16 }}>
        {denyMessage(role, need)} Rôles qui le peuvent : {rolesWith(need).map((r) => ROLE_LABEL[r].toLowerCase()).join(", ")}.
      </Banner>
      <Link className="btn btn-ghost btn-sm" href={back.href}><Icon name="back" />{back.label}</Link>
    </div>
  );
}

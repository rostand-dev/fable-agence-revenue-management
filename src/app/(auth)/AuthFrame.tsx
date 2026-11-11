import { Logo } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";
import { AGENTS } from "@/lib/agents/registry";

export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth">
      <section className="auth-pitch">
        <Logo width={200} />
        <h1>Une agence de revenue management, sans la prestation.</h1>
        <p>Huit agents IA surveillent chaque jour le calendrier de vos locations, expliquent ce qui se passe et instruisent les décisions. PriceLabs reste votre moteur de prix ; vous gardez la validation.</p>
        <div className="crew-line stack" style={{ ["--gap" as any]: "10px" }}>
          <div className="crew">{AGENTS.map((a) => <Avatar key={a.id} agent={a.id} size={44} title={`${a.name}, ${a.title}`} />)}</div>
          <p className="muted">Direction, données, marché, tarification, distribution, annonce, audit et reporting : chaque poste a une mission, des droits et des limites.</p>
        </div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          <li>Une occupation faible ne déclenche jamais une baisse de prix sans diagnostic.</li>
          <li>Aucune action sous votre plancher économique : l'auditeur dispose d'un veto.</li>
          <li>Rien n'est écrit dans un outil externe sans votre approbation.</li>
        </ul>
      </section>
      <section className="auth-form">{children}</section>
    </main>
  );
}

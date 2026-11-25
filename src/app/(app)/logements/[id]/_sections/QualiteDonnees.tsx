import { Byline, State } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { promosToVerify } from "./sources";
import type { Fiche } from "./context";

/** Fraîcheur et complétude des sources de la revue. */
export function QualiteDonnees({ p, input, now, model, names, miss, hasHistory, hasCal }: Fiche) {
  return (
        <section className="stack">
          <div className="table-wrap"><table className="econ">
            <thead><tr><th scope="col">Donnée</th><th scope="col">Source</th><th scope="col">État</th><th scope="col">Détail</th></tr></thead>
            <tbody>
              <tr><th scope="row">Réservations</th><td>{p.isDemo ? "Démonstration" : "PriceLabs · relais du PMS"}</td><td>{hasHistory ? <State role="sain">lues</State> : <State role="attention">absentes</State>}</td><td>{input.resas.length} réservations{hasHistory ? ` · dernière arrivée ${fmtDate(input.resas.map((r) => r.checkIn).sort().at(-1)!)}` : ""}</td></tr>
              <tr><th scope="row">Calendrier et prix</th><td>{p.isDemo ? "Démonstration" : "PriceLabs"}</td><td>{hasCal ? <State role="sain">lus</State> : <State role="attention">absents</State>}</td><td>{input.days.length} jours · {input.days.filter((d) => d.priceCents === null).length} prix inconnus</td></tr>
              <tr><th scope="row">Marché</th><td>{p.isDemo ? "Démonstration" : "PriceLabs"}</td><td>{input.days.some((d) => d.marketOccupancy !== null) ? <State role="sain">lu</State> : <State role="attention">absent ou périmé</State>}</td><td>{input.days.filter((d) => d.marketOccupancy === null).length} jours sans occupation de marché</td></tr>
              <tr><th scope="row">Promotions</th><td>Registre manuel</td><td>{promosToVerify({ input, now }) ? <State role="attention">à vérifier</State> : <State role="sain">à jour</State>}</td><td>{input.promos.length} active(s)</td></tr>
              <tr><th scope="row">Modèle économique</th><td>{model.origin === "DEMO" ? "Démonstration" : "Onboarding"}</td><td>{miss.length ? <State role="attention">incomplet</State> : <State role="sain">complet</State>}</td><td>{miss.length ? miss.join(", ") : "Planchers calculables"}</td></tr>
            </tbody></table></div>
          <p><Byline agent="onboarding" names={names} what="contrôle ces sources à chaque revue" /> <span className="muted">· relevé du {fmtDateTime(now)}</span></p>
        </section>
  );
}

import Link from "next/link";
export default function NotFound() {
  return <main className="content" style={{ maxWidth: 560, margin: "12vh auto" }}><div className="empty"><h3>Page introuvable</h3><p>Cette adresse n'existe pas, ou l'élément demandé n'est pas dans votre espace.</p><p style={{ marginTop: 16 }}><Link className="btn btn-primary" href="/">Retour à l'accueil</Link></p></div></main>;
}

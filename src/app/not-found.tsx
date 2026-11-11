import Link from "next/link";
export default function NotFound() {
  return <main className="content" style={{ maxWidth: 560, margin: "12vh auto" }}><div className="empty"><h3>Page introuvable</h3><p>Ce dossier ou ce logement n'existe pas dans votre espace.</p><p style={{ marginTop: 16 }}><Link className="btn btn-primary" href="/">Retour aux opportunités</Link></p></div></main>;
}

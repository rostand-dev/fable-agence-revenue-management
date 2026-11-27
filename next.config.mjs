/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  // les anciens Réglages sont devenus les Paramètres (308) ; le navigateur conserve l'ancre, que la page d'accueil des Paramètres suit
  async redirects() {
    return [{ source: "/reglages", destination: "/parametres", permanent: true }];
  },
  // en-têtes ; pages de récupération de compte : le jeton est dans l'URL, donc ni cache, ni Referer, ni indexation
  async headers() {
    const secure = [
      { key: "Cache-Control", value: "no-store, max-age=0" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ];
    return [
      // portraits de l'équipe : dossier versionné, donc gardés un an par le navigateur
      { source: "/avatars/v2/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/reinitialisation/:path*", headers: secure },
      { source: "/confirmation/:path*", headers: secure },
      { source: "/mot-de-passe-oublie", headers: secure },
    ];
  },
};
export default nextConfig;

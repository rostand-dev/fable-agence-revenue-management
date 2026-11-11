import type { Metadata, Viewport } from "next";
import "./od-layout.css";
import "./cockpit.css";
import "./app.css";

export const metadata: Metadata = {
  title: { default: "NuitSignal — votre agence de revenue management", template: "%s · NuitSignal" },
  description: "Une équipe d'agents IA surveille, explique et ajuste la stratégie de revenu de vos locations de courte durée. Vous gardez la décision.",
  icons: { icon: "/brand/icon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#04050a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body>{children}</body></html>;
}

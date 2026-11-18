import { redirect } from "next/navigation";
import { demoReadonly } from "@/lib/demo-mode";
import { getUser } from "@/lib/auth";
import { AuthFrame } from "../AuthFrame";
import { ForgotForm } from "../ForgotForm";

export const metadata = { title: "Mot de passe oublié", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function Page() {
  if (demoReadonly()) redirect("/demo"); // démo publique : pas de compte à saisir
  if (await getUser()) redirect("/");
  return <AuthFrame><ForgotForm /></AuthFrame>;
}

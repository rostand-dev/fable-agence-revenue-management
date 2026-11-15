import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { AuthFrame } from "../AuthFrame";
import { ForgotForm } from "../ForgotForm";

export const metadata = { title: "Mot de passe oublié", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function Page() {
  if (await getUser()) redirect("/");
  return <AuthFrame><ForgotForm /></AuthFrame>;
}

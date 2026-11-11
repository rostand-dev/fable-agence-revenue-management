import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { AuthFrame } from "../AuthFrame";
import { AuthForm } from "../AuthForm";

export const metadata = { title: "Connexion" };
export const dynamic = "force-dynamic";
export default async function Page() {
  if (await getUser()) redirect("/");
  return <AuthFrame><AuthForm mode="login" action={loginAction} /></AuthFrame>;
}

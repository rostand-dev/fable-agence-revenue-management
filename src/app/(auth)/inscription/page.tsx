import { redirect } from "next/navigation";
import { signupAction } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { AuthFrame } from "../AuthFrame";
import { AuthForm } from "../AuthForm";

export const metadata = { title: "Créer un compte" };
export const dynamic = "force-dynamic";
export default async function Page() {
  if (await getUser()) redirect("/");
  return <AuthFrame><AuthForm mode="signup" action={signupAction} /></AuthFrame>;
}

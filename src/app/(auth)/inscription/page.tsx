import { redirect } from "next/navigation";
import { demoReadonly, demoSignupUrl } from "@/lib/demo-mode";
import { signupAction } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { signupConfirmationEnabled } from "@/lib/signup";
import { AuthFrame } from "../AuthFrame";
import { AuthForm } from "../AuthForm";

export const metadata = { title: "Créer un compte" };
export const dynamic = "force-dynamic";
export default async function Page() {
  if (demoReadonly()) redirect(demoSignupUrl() ?? "/demo"); // démo : la création de compte se fait sur la production
  if (await getUser()) redirect("/");
  return <AuthFrame><AuthForm mode="signup" action={signupAction} confirmation={signupConfirmationEnabled()} /></AuthFrame>;
}

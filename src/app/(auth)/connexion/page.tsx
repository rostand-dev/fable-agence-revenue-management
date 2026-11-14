import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { getUser } from "@/lib/auth";
import { AuthFrame } from "../AuthFrame";
import { AuthForm } from "../AuthForm";

export const metadata = { title: "Connexion" };
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ expire?: string }> }) {
  if (await getUser()) redirect("/");
  const { expire } = await searchParams;
  return <AuthFrame><AuthForm mode="login" action={loginAction} expired={expire === "1"} /></AuthFrame>;
}

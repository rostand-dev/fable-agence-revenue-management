import { redirect } from "next/navigation";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, ensureMigrated, schema } from "@/db";
import { getUser } from "@/lib/auth";
import { hashToken, looksLikeToken } from "@/lib/password-reset";
import { AuthFrame } from "../../AuthFrame";
import { ConfirmForm, InvalidSignupLink } from "../../ConfirmForm";

export const metadata = { title: "Activer mon espace", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ jeton: string }> }) {
  if (await getUser()) redirect("/");
  const { jeton } = await params;
  await ensureMigrated();
  // simple lecture : la page ne crée rien (les antivirus et aperçus d'e-mail ouvrent les liens), le compte est créé au clic sur le bouton
  let valid = false;
  if (looksLikeToken(jeton)) {
    const [row] = await db.select({ id: schema.signupConfirmations.id }).from(schema.signupConfirmations)
      .where(and(eq(schema.signupConfirmations.tokenHash, hashToken(jeton)), isNull(schema.signupConfirmations.usedAt), gt(schema.signupConfirmations.expiresAt, new Date())));
    valid = !!row;
  }
  return <AuthFrame>{valid ? <ConfirmForm token={jeton} /> : <InvalidSignupLink />}</AuthFrame>;
}

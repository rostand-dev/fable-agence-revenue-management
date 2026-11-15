import { redirect } from "next/navigation";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, ensureMigrated, schema } from "@/db";
import { getUser } from "@/lib/auth";
import { hashToken, looksLikeToken } from "@/lib/password-reset";
import { AuthFrame } from "../../AuthFrame";
import { InvalidLink, ResetForm } from "../../ResetForm";

export const metadata = { title: "Nouveau mot de passe", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ jeton: string }> }) {
  if (await getUser()) redirect("/");
  const { jeton } = await params;
  await ensureMigrated();
  // simple lecture : le lien n'est consommé qu'à l'enregistrement du nouveau mot de passe
  let valid = false;
  if (looksLikeToken(jeton)) {
    const [row] = await db.select({ id: schema.passwordResets.id }).from(schema.passwordResets)
      .where(and(eq(schema.passwordResets.tokenHash, hashToken(jeton)), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, new Date())));
    valid = !!row;
  }
  return <AuthFrame>{valid ? <ResetForm token={jeton} /> : <InvalidLink />}</AuthFrame>;
}

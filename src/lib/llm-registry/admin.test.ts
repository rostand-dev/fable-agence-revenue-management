import { describe, expect, it } from "vitest";
import { isLlmAdmin, llmAdminEmails } from "./admin";

describe("exploitant de la plateforme (LLM_ADMIN_EMAILS)", () => {
  it("variable absente ou vide : personne", () => { expect(isLlmAdmin("a@x.fr", {})).toBe(false); expect(isLlmAdmin("a@x.fr", { LLM_ADMIN_EMAILS: " " })).toBe(false); });
  it("liste séparée par virgules, points-virgules ou espaces, sans tenir compte de la casse", () => {
    const env = { LLM_ADMIN_EMAILS: "A@x.fr, b@x.fr;c@x.fr  d@x.fr" };
    expect(llmAdminEmails(env)).toEqual(["a@x.fr", "b@x.fr", "c@x.fr", "d@x.fr"]);
    expect(isLlmAdmin(" B@X.FR ", env)).toBe(true); expect(isLlmAdmin("e@x.fr", env)).toBe(false); expect(isLlmAdmin(null, env)).toBe(false);
  });
});

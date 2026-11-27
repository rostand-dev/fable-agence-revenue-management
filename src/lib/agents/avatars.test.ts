import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS, AVATAR_DIR, avatarSrc } from "./registry";

const file = (src: string) => join(process.cwd(), "public", src);

describe("portraits de l'équipe", () => {
  it.each(AGENTS.map((a) => [a.name, a.id] as const))("%s a son image WebP, légère", (_name, id) => {
    const bytes = readFileSync(file(avatarSrc(id)));
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(bytes.length).toBeLessThan(40_000);
  });

  it("la règle de cache vise le dossier servi", () => {
    expect(readFileSync(join(process.cwd(), "next.config.mjs"), "utf8")).toContain(`"${AVATAR_DIR}/:file*"`);
  });

  it("le dossier ne contient aucune image sans poste", () => {
    expect(readdirSync(file(AVATAR_DIR)).sort()).toEqual(AGENTS.map((a) => `${a.id}.webp`).sort());
  });
});

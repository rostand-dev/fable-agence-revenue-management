import { defineConfig } from "vitest/config";
import path from "node:path";
// Tests d'intégration sur une vraie base PostgreSQL : TEST_DATABASE_URL obligatoire, base dédiée (son nom doit contenir « test »).
// La base est vidée et les migrations rejouées au lancement. Fichiers exécutés l'un après l'autre : ils partagent la base.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["./src/test/db-global-setup.ts"],
    setupFiles: ["./src/test/db-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});

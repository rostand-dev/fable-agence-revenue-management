import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";
// Tests purs (sans base de données). Ceux qui exigent PostgreSQL s'appellent *.db.test.ts et se lancent avec `npm run test:db`.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: [...configDefaults.exclude, "src/**/*.db.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});

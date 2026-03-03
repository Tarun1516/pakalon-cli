import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.PAKALON_DB_PATH ?? `${process.env.HOME}/.config/pakalon/pakalon.sqlite`,
  },
  verbose: true,
  strict: true,
});

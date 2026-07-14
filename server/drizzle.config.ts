import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { defineConfig } from "drizzle-kit";

// The proto keeps its .env at the repo root (same file the server loads).
// drizzle-kit bundles this config as CJS, so no import.meta here — run kit
// from the server/ directory.
dotenvConfig({ path: resolve(process.cwd(), "../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (repo-root .env)");
}

// Introspection-only config (drizzle-kit pull). The live Neon schema is owned
// by the historical Prisma migrations in prisma/migrations — NEVER run
// `drizzle-kit push` or `generate` against it: Drizzle's constraint-naming
// convention differs from Prisma's, so push would try to drop/recreate
// constraints on a database whose schema must not change.
//
// Version gotcha: drizzle-kit 0.30/0.31 `pull` requires drizzle-orm >= 0.41
// at require-time (drizzle-orm/gel-core), while this repo pins drizzle-orm
// ^0.39 to match the parent Pluvus platform. The 2026-07-14 introspection
// (server/drizzle/introspected-schema.reference.ts) was therefore produced in
// a scratch project with drizzle-kit@0.31.4 + drizzle-orm@0.41.0 pointed at
// the same DATABASE_URL. Repeat that setup if a re-pull is ever needed.
export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});

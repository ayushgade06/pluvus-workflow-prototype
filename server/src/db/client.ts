import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

// Load .env from the project root (parent of server/). Safe to call multiple
// times — dotenv skips keys that are already set, so this never overwrites an
// env var injected by the shell or by an earlier dotenv.config() call.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../../../.env") });

const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });

// Singleton Prisma client. Import this everywhere instead of constructing
// a new PrismaClient, which would open redundant connection pools.
export const prisma = new PrismaClient({
  adapter,
  log: process.env["NODE_ENV"] === "development" ? ["query", "warn", "error"] : ["warn", "error"],
});

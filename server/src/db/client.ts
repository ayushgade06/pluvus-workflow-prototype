import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });

// Singleton Prisma client. Import this everywhere instead of constructing
// a new PrismaClient, which would open redundant connection pools.
export const prisma = new PrismaClient({
  adapter,
  log: process.env["NODE_ENV"] === "development" ? ["query", "warn", "error"] : ["warn", "error"],
});

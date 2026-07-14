// Drizzle client over the SAME Neon Postgres the Prisma migrations created.
// Driver + construction mirror the parent Pluvus platform's server/db.ts
// (@neondatabase/serverless Pool + drizzle-orm/neon-serverless + ws) so the
// later merge is copy-paste.
//
// Note on timestamps: every DateTime column is TIMESTAMP(3) WITHOUT time zone
// holding UTC instants (Prisma's convention). Drizzle's neon-serverless driver
// overrides the pg type parsers so its own column mapping applies, and that
// mapping treats naive timestamps as UTC on both read and write — matching
// what Prisma wrote. Do NOT run raw pool.query() with JS Date parameters:
// node-postgres would serialize them with the LOCAL offset and silently skew
// stored times.
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import * as schema from "./schema.js";

// Same repo-root .env the Prisma client loaded (server/src/db → repo root).
const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../../../.env") });

neonConfig.webSocketConstructor = ws;

// Constructed unconditionally: the Pool only connects on first query, so a
// missing DATABASE_URL surfaces at query time (same failure mode the Prisma
// client had) rather than crashing test runs that merely import this module.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;

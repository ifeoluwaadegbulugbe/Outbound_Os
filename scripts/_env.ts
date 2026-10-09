import fs from "node:fs";

/** Load .env.local / .env for CLI scripts (Next.js loads these itself for the app). */
for (const f of [".env.local", ".env"]) {
  if (fs.existsSync(f)) process.loadEnvFile(f);
}

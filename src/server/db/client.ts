import { createDriver, type Driver } from "./driver";
/**
 * Process-wide database singleton.
 *
 * Stored on globalThis because Next.js dev mode can evaluate this module in
 * several bundles inside one Node process; PGlite must have exactly one
 * instance per data directory or it will corrupt it.
 */
const g = globalThis as unknown as { __obDriver?: Promise<Driver> };

export function getDriver(): Promise<Driver> {
  if (!g.__obDriver) {
    g.__obDriver = createDriver().catch((err) => {
      g.__obDriver = undefined;
      throw err;
    });
  }
  return g.__obDriver;
}

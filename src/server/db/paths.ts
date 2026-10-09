import os from "node:os";
import path from "node:path";

/**
 * Local data lives OUTSIDE the project folder (default ~/.outbound-os) so the
 * dev server's file watcher doesn't see database writes and reload the page.
 * Override with OUTBOUND_DATA_DIR or PGLITE_DIR.
 */
export function dataDir(): string {
  return process.env.OUTBOUND_DATA_DIR ?? path.join(os.homedir(), ".outbound-os");
}

export function pgliteDir(): string {
  return process.env.PGLITE_DIR ?? path.join(dataDir(), "pglite");
}

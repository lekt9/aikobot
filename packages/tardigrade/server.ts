/**
 * Bun development server: hosts the Eliza actor over SQLite and serves the
 * Tardigrade HTTP API so `tdg` can allocate threads, call `message`, and read
 * durable traces locally. Reads credentials from the environment (`bun run
 * dev` loads `.dev.vars`).
 */

import { createBunHost, serve } from "tardie/bun";
import actor from "./actor";
import { elizaTurnServicesLayer } from "./src/hosts/config";

const storage = process.env.ELIZA_TARDIGRADE_STORAGE ?? ".tardigrade/eliza";
const port = Number(process.env.PORT ?? 4242);

const host = await createBunHost({
  actor,
  storage,
  layersFor: () => elizaTurnServicesLayer({ env: process.env }),
});

try {
  const server = await serve(host, {
    port,
    token: process.env.TARDIGRADE_TOKEN,
  });
  try {
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await server.close();
  }
} finally {
  await host.close();
}

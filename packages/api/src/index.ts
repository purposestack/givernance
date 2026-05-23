/** API entry point — creates server and starts listening */

import { env } from "./env.js";
import { assertAppRoleSecure } from "./lib/db.js";
import { createServer } from "./server.js";

const { PORT, HOST } = env;

async function main() {
  // Issue #430 — boot-time tenant-isolation guard. Crash fast if
  // `DATABASE_URL_APP` connects as a BYPASSRLS role; a silent leak is
  // worse than no boot.
  await assertAppRoleSecure();

  const server = await createServer();

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Givernance API listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error("FATAL ERROR ON STARTUP:", err);
    server.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR ON STARTUP:", err);
  process.exit(1);
});

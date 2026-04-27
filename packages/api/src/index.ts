/** API entry point — creates server and starts listening */

import { env } from "./env.js";
import { createServer } from "./server.js";

const { PORT, HOST } = env;

async function main() {
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

main();

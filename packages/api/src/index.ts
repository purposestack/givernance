/** API entry point — creates server and starts listening */

import { createServer } from './server.js'

const PORT = Number(process.env['PORT'] ?? 4000)
const HOST = process.env['HOST'] ?? '0.0.0.0'

async function main() {
  const server = await createServer()

  try {
    await server.listen({ port: PORT, host: HOST })
    server.log.info(`Givernance API listening on ${HOST}:${PORT}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

main()

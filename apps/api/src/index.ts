import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'

const config = loadConfig()
const db = createDb(config.DATABASE_PATH)
const app = await buildApp({ config, db })

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
    process.exit(0)
  } catch (err) {
    app.log.error({ err }, 'error during shutdown')
    process.exit(1)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ host: config.HOST, port: config.PORT })

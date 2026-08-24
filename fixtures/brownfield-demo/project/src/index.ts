import { createServer } from "./server.js";
import { logger } from "./shared/logger.js";

const port = Number(process.env.PORT ?? 3000);

createServer().listen(port, () => {
  logger.info("server listening", { port });
});

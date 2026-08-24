import http from "node:http";
import { handleRoute } from "./routes.js";
import { logger } from "./shared/logger.js";

export function createServer() {
  return http.createServer((req, res) => {
    logger.info("request", { method: req.method, url: req.url });
    handleRoute(req, res);
  });
}

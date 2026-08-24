// Structured JSON logging shared by every module. Shared code imports no
// feature module — the dependency arrow only points inward.
type Level = "info" | "warn" | "error";

export const logger = {
  info(message: string, meta: Record<string, unknown> = {}): void {
    emit("info", message, meta);
  },
  warn(message: string, meta: Record<string, unknown> = {}): void {
    emit("warn", message, meta);
  },
  error(message: string, meta: Record<string, unknown> = {}): void {
    emit("error", message, meta);
  },
};

function emit(level: Level, message: string, meta: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, message, ...meta })}\n`);
}

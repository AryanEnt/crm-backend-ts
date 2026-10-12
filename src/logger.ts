import { pino } from "pino";

/** JSON logs shaped like the Go backend's slog output: {"time","level":"INFO","msg",...}. */
export const logger = pino({
  base: null,
  messageKey: "msg",
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
});

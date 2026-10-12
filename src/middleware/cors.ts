import type { RequestHandler } from "express";

export function parseOrigins(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const origin = part.trim().replace(/\/+$/, "");
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** CORS for one or more frontend origins (comma-separated FRONTEND_URL), as in the Go backend. */
export function cors(frontendUrls: string): RequestHandler {
  const allowed = parseOrigins(frontendUrls);
  return (req, res, next) => {
    const origin = req.get("Origin");
    if (origin) {
      const wanted = origin.trim().replace(/\/+$/, "").toLowerCase();
      const match = allowed.find((a) => a.toLowerCase() === wanted);
      if (match) {
        res.setHeader("Access-Control-Allow-Origin", match);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    } else if (allowed.length === 1) {
      res.setHeader("Access-Control-Allow-Origin", allowed[0]!);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Request-ID");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

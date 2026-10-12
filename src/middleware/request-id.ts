import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const requestId: RequestHandler = (req, res, next) => {
  const id = req.get("X-Request-ID") || randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
};

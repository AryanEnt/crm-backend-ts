import { Router } from "express";

/**
 * Routes match like Go's ServeMux: case-sensitive and without an implicit trailing slash,
 * so e.g. "/api/v1/pipelines/" falls through to the Go proxy just as Go would 404 it.
 */
export function createRouter(): Router {
  return Router({ caseSensitive: true, strict: true });
}

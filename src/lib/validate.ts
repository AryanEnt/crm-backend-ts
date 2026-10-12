import type { Request } from "express";
import { z } from "zod";
import { AppError } from "./app-error.js";

/**
 * Parses the JSON body like the Go backend's validate.DecodeJSON: a missing body or
 * unknown fields are validation errors. Schemas should use z.strictObject and the
 * helpers below, which reproduce Go's decoding rules: JSON null leaves a non-pointer
 * field at its zero value, and a pointer field is "not provided" when absent or null.
 */
export function decodeJson<S extends z.ZodType>(req: Request, schema: S): z.output<S> {
  if (req.body === undefined) {
    throw AppError.validation("invalid JSON body: EOF");
  }
  const body = req.body === null ? {} : foldKeys(req.body, schema);
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw AppError.validation(`invalid JSON body: ${describeIssue(result.error.issues[0])}`);
}

/** Go's encoding/json matches object keys to struct fields case-insensitively, in nested structs too. */
function foldKeys(body: unknown, schema: z.ZodType): unknown {
  const obj = objectSchema(schema);
  if (!obj || body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const shape = obj.shape as Record<string, z.ZodType>;
  const known = Object.keys(shape);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const target = known.includes(key) ? key : (known.find((k) => k.toLowerCase() === key.toLowerCase()) ?? key);
    const field = shape[target];
    out[target] = field ? foldKeys(value, field) : value;
  }
  return out;
}

/** The object schema behind optional/nullable/transform wrappers, if any. */
function objectSchema(schema: z.ZodType): z.ZodObject | null {
  let s: unknown = schema;
  for (let i = 0; i < 10; i++) {
    if (s instanceof z.ZodObject) return s;
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodPipe) s = s.in;
    else return null;
  }
  return null;
}

function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "invalid body";
  if (issue.code === "unrecognized_keys") {
    return `json: unknown field "${issue.keys[0] ?? ""}"`;
  }
  const field = issue.path.map(String).join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

/** Go string: absent or null -> "". */
export const str = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? "");

/** Go bool: absent or null -> false. */
export const bool = () =>
  z
    .boolean()
    .nullish()
    .transform((v) => v ?? false);

/** Go int: absent or null -> 0; fractions are rejected. */
export const int = () =>
  z
    .number()
    .int()
    .nullish()
    .transform((v) => v ?? 0);

/** Go float64: absent or null -> 0. */
export const num = () =>
  z
    .number()
    .nullish()
    .transform((v) => v ?? 0);

/** Go *string: absent or null -> undefined. */
export const optionalString = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? undefined);

/** Go *bool. */
export const optionalBool = () =>
  z
    .boolean()
    .nullish()
    .transform((v) => v ?? undefined);

/** Go *int. */
export const optionalInt = () =>
  z
    .number()
    .int()
    .nullish()
    .transform((v) => v ?? undefined);

/** Go *float64. */
export const optionalNumber = () =>
  z
    .number()
    .nullish()
    .transform((v) => v ?? undefined);

/** Go []string: absent or null -> undefined (nil); null elements -> "". */
export const stringArray = () =>
  z
    .array(str())
    .nullish()
    .transform((v) => v ?? undefined);

/** Go *Struct: absent or null -> undefined (nil). */
export const optionalObject = <S extends z.ZodType>(schema: S) =>
  schema.nullish().transform((v) => v ?? undefined);

/** Go map[string]any: absent or null -> undefined (nil). */
export const anyMap = () =>
  z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? undefined);

export function requiredString(field: string, value: string): void {
  if (value.trim() === "") throw AppError.validation(`${field} is required`);
}

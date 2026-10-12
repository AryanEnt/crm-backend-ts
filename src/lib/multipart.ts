import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import type { Request } from "express";
import { queryParam } from "./query.js";

export interface UploadedFile {
  filename: string;
  mimeType: string;
  size: number;
  /** Temporary copy on disk; removed by MultipartForm.cleanup(). */
  tempPath: string;
  open(): Readable;
}

export class MultipartForm {
  constructor(
    private readonly req: Request,
    private readonly fields: Map<string, string[]>,
    private readonly files: Map<string, UploadedFile[]>,
  ) {}

  /** Go's r.FormValue: the multipart value, else the query parameter, else "". */
  value(key: string): string {
    return this.fields.get(key)?.[0] ?? queryParam(this.req, key);
  }

  /** Go's r.FormFile: the first file uploaded under key. */
  file(key: string): UploadedFile | undefined {
    return this.files.get(key)?.[0];
  }

  async cleanup(): Promise<void> {
    const all = [...this.files.values()].flat();
    await Promise.all(all.map((f) => rm(f.tempPath, { force: true })));
  }
}

export class InvalidMultipartError extends Error {}

/**
 * Reads the whole multipart body before the handler runs, like Go's ParseMultipartForm:
 * files are spooled to temp files so nothing is stored until validation passes.
 * A part with an empty filename is a plain value, as in Go's multipart reader.
 */
export function parseMultipart(req: Request): Promise<MultipartForm> {
  return new Promise((resolve, reject) => {
    const fields = new Map<string, string[]>();
    const files = new Map<string, UploadedFile[]>();
    const writes: Promise<void>[] = [];
    const form = new MultipartForm(req, fields, files);
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);

    const failWith = (err: unknown) => {
      req.unpipe();
      req.resume();
      void form.cleanup().finally(() => reject(new InvalidMultipartError(String(err))));
    };

    let bb: busboy.Busboy;
    try {
      const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "multipart/form-data") throw new Error("request Content-Type isn't multipart/form-data");
      bb = busboy({ headers: req.headers, preservePath: false, defParamCharset: "utf8" });
    } catch (err) {
      failWith(err);
      return;
    }

    bb.on("field", (name, value) => push(fields, name, value));
    bb.on("file", (name, stream, info) => {
      if (!info.filename) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => push(fields, name, Buffer.concat(chunks).toString("utf8")));
        return;
      }
      const tempPath = path.join(tmpdir(), `crm-upload-${randomUUID()}`);
      const file: UploadedFile = {
        filename: info.filename,
        mimeType: info.mimeType,
        size: 0,
        tempPath,
        open: () => createReadStream(tempPath),
      };
      push(files, name, file);
      stream.on("data", (c: Buffer) => (file.size += c.length));
      writes.push(pipeline(stream, createWriteStream(tempPath)));
    });
    bb.on("error", failWith);
    bb.on("close", () => {
      Promise.all(writes).then(() => resolve(form), failWith);
    });
    req.pipe(bb);
  });
}

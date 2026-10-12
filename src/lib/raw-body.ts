import type { Request } from "express";

/**
 * Reads up to limit bytes of the request body. With truncate the rest is discarded like
 * io.LimitReader; otherwise tooLarge reports that the body exceeded the limit.
 */
export function readBody(req: Request, limit: number, truncate: boolean): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (size >= limit) {
        tooLarge = true;
        return;
      }
      const room = limit - size;
      if (chunk.length > room) tooLarge = true;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(part);
      size += part.length;
    });
    req.on("end", () => resolve({ body: Buffer.concat(chunks), tooLarge: tooLarge && !truncate }));
    req.on("error", reject);
  });
}

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../../logger.js";

export interface ObjectMeta {
  key: string;
  size: number;
  contentType: string;
  provider: string;
}

/** File storage abstraction (Go storage.Store); swap drivers without touching CRM code. */
export interface Store {
  provider(): string;
  put(key: string, body: Readable, contentType: string): Promise<ObjectMeta>;
  open(key: string): Promise<{ body: Readable; meta: ObjectMeta }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Filesystem-backed store. Keys resolve under root and cannot escape it. */
export class LocalStore implements Store {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root.trim() === "" ? "./storage" : root);
    mkdirSync(this.root, { recursive: true });
  }

  provider(): string {
    return "local";
  }

  private resolve(key: string): string {
    const clean = path.posix.normalize("/" + key.replaceAll("\\", "/")).replace(/^\/+/, "");
    const full = path.join(this.root, clean);
    if (!full.startsWith(this.root)) throw new Error("invalid storage key");
    return full;
  }

  async put(key: string, body: Readable, contentType: string): Promise<ObjectMeta> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    let size = 0;
    body.on("data", (chunk: Buffer) => (size += chunk.length));
    await pipeline(body, createWriteStream(file));
    return { key, size, contentType: contentType || "application/octet-stream", provider: this.provider() };
  }

  async open(key: string): Promise<{ body: Readable; meta: ObjectMeta }> {
    const file = this.resolve(key);
    const st = await stat(file);
    return {
      body: createReadStream(file),
      meta: { key, size: st.size, contentType: "application/octet-stream", provider: this.provider() },
    };
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

/** Go router: an unsupported driver logs and falls back to local storage. */
export function createStore(driver: string, root: string): Store {
  switch (driver.trim().toLowerCase()) {
    case "":
    case "local":
    case "filesystem":
    case "fs":
      return new LocalStore(root);
    default:
      logger.error({ driver }, "storage init failed: unsupported storage driver (implement Store to add providers)");
      return new LocalStore(root);
  }
}

let lastStamp = 0n;

/** Go storage.NewObjectKey: "<prefix>/<unix nanos>_<safe base name>". */
export function newObjectKey(prefix: string, filename: string): string {
  let safe = path.basename(filename.replaceAll("..", "_"));
  if (safe === "" || safe === ".") safe = "file";
  let stamp = BigInt(Date.now()) * 1_000_000n;
  if (stamp <= lastStamp) stamp = lastStamp + 1n;
  lastStamp = stamp;
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${stamp}_${safe}`;
}

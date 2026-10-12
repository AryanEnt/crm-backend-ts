import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { ObjectMeta, Store } from "./storage.js";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
}

/** Cloudflare R2 via the S3 API. Used for lead screenshots. */
export class R2Store implements Store {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: R2Config) {
    const accountId = cfg.accountId.trim();
    const endpoint = cfg.endpoint.trim().replace(/\/+$/, "") || `https://${accountId}.r2.cloudflarestorage.com`;
    // R2 bucket names are always lowercase; "CRM" is rejected as InvalidBucketName.
    this.bucket = cfg.bucket.trim().toLowerCase();
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId: cfg.accessKeyId.trim(), secretAccessKey: cfg.secretAccessKey.trim() },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  provider(): string {
    return "r2";
  }

  async put(key: string, body: Readable, contentType: string): Promise<ObjectMeta> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const type = contentType || "application/octet-stream";
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: type,
        ContentLength: bytes.length,
      }),
    );
    return { key, size: bytes.length, contentType: type, provider: this.provider() };
  }

  async open(key: string): Promise<{ body: Readable; meta: ObjectMeta }> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error("empty r2 object");
    return {
      body: out.Body as Readable,
      meta: {
        key,
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType || "application/octet-stream",
        provider: this.provider(),
      },
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const name = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
      throw err;
    }
  }
}

/** Null when the four R2 settings are incomplete, so the API still boots. */
export function createR2Store(cfg: R2Config): Store | null {
  if (!cfg.accountId.trim() || !cfg.accessKeyId.trim() || !cfg.secretAccessKey.trim() || !cfg.bucket.trim()) return null;
  return new R2Store(cfg);
}

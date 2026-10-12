import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, primaryFrontendUrl } from "../src/config.js";
import { defaultMigrationsDir, listMigrations, parseVersion } from "../src/db/migrate.js";
import { formatUptime } from "../src/modules/health/health.routes.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("config", () => {
  it("requires DATABASE_URL and JWT_SECRET", () => {
    setEnv({ DATABASE_URL: undefined, JWT_SECRET: undefined });
    expect(() => loadConfig()).toThrow(/DATABASE_URL, JWT_SECRET/);
  });

  it("prefers API_PORT over PORT and falls back to 8080, like the Go config", () => {
    setEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "s", PORT: "9090", API_PORT: "8080" });
    expect(loadConfig().port).toBe(8080);
    setEnv({ API_PORT: undefined });
    expect(loadConfig().port).toBe(9090);
    setEnv({ PORT: undefined, API_PORT: "7070" });
    expect(loadConfig().port).toBe(7070);
    setEnv({ API_PORT: undefined });
    expect(loadConfig().port).toBe(8080);
    setEnv({ PORT: "nope" });
    expect(() => loadConfig()).toThrow(/API_PORT must be a valid port number/);
  });

  it("uses the first FRONTEND_URL entry as the primary origin", () => {
    expect(primaryFrontendUrl("http://localhost:3000, http://10.110.110.77:3000")).toBe("http://localhost:3000");
    expect(primaryFrontendUrl(" , https://app.example.com/ ")).toBe("https://app.example.com");
  });

  it("TOKEN_ENCRYPTION_KEY falls back to JWT_SECRET; GO_BACKEND_URL trailing slash is dropped", () => {
    setEnv({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "jwt",
      TOKEN_ENCRYPTION_KEY: undefined,
      GO_BACKEND_URL: "http://go:8080/",
    });
    const cfg = loadConfig();
    expect(cfg.tokenEncryptionKey).toBe("jwt");
    expect(cfg.goBackendUrl).toBe("http://go:8080");
  });
});

describe("migrations", () => {
  it("parses versions like the Go runner", () => {
    expect(parseVersion("000017_gmail_email.up.sql")).toBe(17);
    expect(() => parseVersion("abc_x.up.sql")).toThrow();
  });

  it("lists up migrations in lexicographic order", async () => {
    const files = await listMigrations(defaultMigrationsDir());
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith(".up.sql"))).toBe(true);
    expect([...files].sort()).toEqual(files);
  });

  // While both backends share the database, their migration sets must stay identical.
  const goDir = path.resolve(import.meta.dirname, "../../backend/internal/database/migrations");
  it.skipIf(!existsSync(goDir))("match the Go backend's embedded migrations byte for byte", async () => {
    const ours = (await readdir(defaultMigrationsDir())).filter((f) => f.endsWith(".sql")).sort();
    const theirs = (await readdir(goDir)).filter((f) => f.endsWith(".sql")).sort();
    expect(ours).toEqual(theirs);
    for (const f of ours) {
      const [a, b] = await Promise.all([
        readFile(path.join(defaultMigrationsDir(), f), "utf8"),
        readFile(path.join(goDir, f), "utf8"),
      ]);
      expect(a, f).toBe(b);
    }
  });
});

describe("formatUptime", () => {
  it("matches Go's Duration.String rounded to seconds", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45_400)).toBe("45s");
    expect(formatUptime(814_000)).toBe("13m34s");
    expect(formatUptime(3_600_000)).toBe("1h0m0s");
    expect(formatUptime(7_205_000)).toBe("2h0m5s");
  });
});

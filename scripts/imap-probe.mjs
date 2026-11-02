// Diagnoses an IMAP/SMTP mailbox connection without printing credentials.
// Usage: node scripts/imap-probe.mjs [host] [port]
//   IMAP_USER / IMAP_PASS env vars are optional; without them a deliberately wrong login is used.
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { ImapFlow } from "imapflow";

const host = process.argv[2] || "imap.migadu.com";
const port = Number(process.argv[3] || 993);
if (process.env.IMAP_USER && !process.env.IMAP_PASS) {
  console.error("IMAP_USER is set but IMAP_PASS is empty; refusing to send a wrong password to a real mailbox.");
  process.exit(2);
}
const user = process.env.IMAP_USER || "probe-nonexistent@example.invalid";
const pass = process.env.IMAP_PASS || "wrong-password";

function step(name, data) {
  console.log(`[${name}]`, JSON.stringify(data));
}

try {
  const addrs = await dns.lookup(host, { all: true });
  step("dns", addrs);
} catch (err) {
  step("dns-error", { code: err.code, message: err.message });
  process.exit(1);
}

await new Promise((resolve) => {
  const started = Date.now();
  const sock = net.connect({ host, port, timeout: 10_000 });
  sock.once("connect", () => {
    step("tcp", { ok: true, ms: Date.now() - started, remote: sock.remoteAddress });
    sock.destroy();
    resolve();
  });
  sock.once("timeout", () => {
    step("tcp-error", { code: "ETIMEDOUT" });
    sock.destroy();
    resolve();
  });
  sock.once("error", (err) => {
    step("tcp-error", { code: err.code, message: err.message });
    resolve();
  });
});

await new Promise((resolve) => {
  const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: true, timeout: 10_000 });
  sock.once("secureConnect", () => {
    const cert = sock.getPeerCertificate();
    step("tls", {
      authorized: sock.authorized,
      protocol: sock.getProtocol(),
      subject: cert?.subject?.CN,
      issuer: cert?.issuer?.O,
      validTo: cert?.valid_to,
    });
    sock.once("data", (buf) => {
      step("greeting", buf.toString("utf8").trim().slice(0, 120));
      sock.destroy();
      resolve();
    });
  });
  sock.once("timeout", () => {
    step("tls-error", { code: "ETIMEDOUT" });
    sock.destroy();
    resolve();
  });
  sock.once("error", (err) => {
    step("tls-error", { code: err.code, message: err.message });
    resolve();
  });
});

const client = new ImapFlow({
  host,
  port,
  secure: port === 993,
  auth: { user, pass },
  tls: { rejectUnauthorized: true },
  logger: false,
});
client.on("error", (err) => step("client-error-event", { message: err.message, code: err.code }));
client.on("close", () => step("imap-closed", { usable: client.usable }));
console.log("[imap] logging in (failed logins can take ~10s to answer)…");
try {
  await client.connect();
  step("imap-login", { ok: true, user: user.replace(/^(.).*(@.*)$/, "$1***$2") });
  const boxes = await client.list();
  step("imap-list", boxes.map((b) => ({ path: b.path, specialUse: b.specialUse })));
} catch (err) {
  step("imap-error", {
    name: err?.name,
    message: err?.message,
    code: err?.code,
    authenticationFailed: err?.authenticationFailed,
    serverResponseCode: err?.serverResponseCode,
    responseStatus: err?.responseStatus,
    responseText: err?.responseText,
  });
} finally {
  await client.logout().catch(() => undefined);
}

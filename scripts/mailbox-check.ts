// Runs the app's real IMAP + SMTP check against a provider preset. Never prints credentials.
// Usage: MAILBOX_USER=... MAILBOX_PASS=... npx tsx scripts/mailbox-check.ts [migadu|spacemail]
// Without MAILBOX_USER/PASS it uses a deliberately wrong login to exercise the auth-failure path.
import { ImapSmtpTransport } from "../src/modules/email/imap-smtp.js";
import { IMAP_PRESETS } from "../src/modules/email/imap-presets.js";
import { maskMailUser } from "../src/modules/email/email.service.js";

const provider = (process.argv[2] ?? "migadu") as keyof typeof IMAP_PRESETS;
const settings = IMAP_PRESETS[provider];
if (!settings) throw new Error(`unknown provider ${provider}`);
if (process.env.MAILBOX_USER && !process.env.MAILBOX_PASS) {
  console.error("MAILBOX_USER is set but MAILBOX_PASS is empty; refusing to send a wrong password to a real mailbox.");
  process.exit(2);
}
const user = process.env.MAILBOX_USER ?? "probe-nonexistent@example.invalid";
const pass = process.env.MAILBOX_PASS ?? "wrong-password";

const check = await new ImapSmtpTransport(settings).checkConnection({ user, pass });
const view = (r: (typeof check)["imap"] | (typeof check)["smtp"]) =>
  r.ok ? { ok: true, ms: r.ms } : { ok: false, ms: r.ms, code: r.error.code, message: r.error.message, cause: r.error.diagnostics };
console.log(JSON.stringify({ provider, user: maskMailUser(user), settings, imap: view(check.imap), smtp: view(check.smtp) }, null, 2));

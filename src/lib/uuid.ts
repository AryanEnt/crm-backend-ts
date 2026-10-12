const HEX32 = /^[0-9a-f]{32}$/i;
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts the forms Go's uuid.Parse does: canonical, 32 hex, {canonical} and urn:uuid:canonical. */
export function isUuid(value: string): boolean {
  if (CANONICAL.test(value) || HEX32.test(value)) return true;
  if (value.length === 38 && value.startsWith("{") && value.endsWith("}")) {
    return CANONICAL.test(value.slice(1, -1));
  }
  if (value.toLowerCase().startsWith("urn:uuid:")) return CANONICAL.test(value.slice(9));
  return false;
}

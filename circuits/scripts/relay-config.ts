import fs from "fs";
import path from "path";

/**
 * Relay system mailbox — the single source of truth for the relay address the
 * loader's To guard checks against (load-email.ts) and the test-email export
 * instructions (testdata/emails/README.md). Since v1.6 (to_addr static spec)
 * the address is NOT compiled into the circuit DFA: the circuit binds the
 * To addr-spec hash (relayerEmailHash public input), and the address binding
 * is enforced on-chain against the escrow's relayer_email_hash. Changing it
 * therefore does NOT require a circuit rebuild — the full trusted-setup
 * pipeline (scripts/rebuild.sh) only needs to rerun when the circuit itself
 * or a checked-in regex spec changes.
 *
 * Production default: "claim@relay.xyz" (a dedicated relay-domain mailbox; see
 * testdata/emails/README.md and the PRD). The value checked into
 * relay.config.json is the CURRENT test value (the maintainer's Gmail) so a
 * real Gmail can be sent directly To the relay address during tests.
 *
 * Resolution order: RELAY_ADDRESS env var (override for CI/tests) →
 * circuits/relay.config.json.
 */

const CONFIG_PATH = path.join(__dirname, "..", "relay.config.json");

export function getRelayAddress(): string {
  const fromEnv = process.env.RELAY_ADDRESS;
  const addr = (fromEnv && fromEnv.trim()) || readConfigAddress();
  assertValidRelayAddress(addr);
  return addr;
}

/** Regex-escaped relay address for interpolation into regex sources (at minimum `.` → `\.`). */
export function relayAddressRegexEscaped(): string {
  return getRelayAddress().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readConfigAddress(): string {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e: any) {
    throw new Error(`cannot read ${CONFIG_PATH}: ${e?.message ?? e}`);
  }
  const addr = (raw as { relayAddress?: unknown })?.relayAddress;
  if (typeof addr !== "string") {
    throw new Error(`${CONFIG_PATH} must contain {"relayAddress": "<addr>"}`);
  }
  return addr.trim();
}

function assertValidRelayAddress(addr: string): void {
  // The address is interpolated into the DFA regex `(\r\n|^)to:<addr>(\r\n)`:
  // CR/LF would break the spec shape, empty/whitespace values are never valid.
  if (!addr) throw new Error("relay address must be a non-empty string");
  if (/[\r\n]/.test(addr)) throw new Error(`relay address must not contain CR/LF: ${JSON.stringify(addr)}`);
}

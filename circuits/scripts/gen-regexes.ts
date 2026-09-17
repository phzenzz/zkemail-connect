/**
 * Regenerates the To-presence regex artifacts from the configured relay address
 * (circuits/relay.config.json / RELAY_ADDRESS — see relay-config.ts):
 *
 *   1. renders circuits/regex-specs/to_presence.json — decomposed spec, match-only
 *      (all-private, no public parts), pattern `(\r\n|^)to:<escaped-addr>(\r\n)`;
 *   2. runs `zk-regex decomposed` to regenerate
 *      circuits/src/regexes/to_presence_regex.circom (template ToPresenceRegex);
 *   3. works around a codegen quirk of the installed zk-regex 2.3.2: the
 *      no-reveal code path omits the template's closing `}`, so the generated
 *      file is checked and the brace is appended when missing.
 *
 * The address is compiled into the circuit DFA — after this step you must
 * recompile and redo the trusted setup (scripts/rebuild.sh runs the full chain).
 *
 * Usage: cd circuits && npx tsx scripts/gen-regexes.ts
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getRelayAddress, relayAddressRegexEscaped } from "./relay-config";

const CIRCUITS_DIR = path.join(__dirname, "..");
const SPEC_PATH = path.join(CIRCUITS_DIR, "regex-specs", "to_presence.json");
const CIRCOM_PATH = path.join(CIRCUITS_DIR, "src", "regexes", "to_presence_regex.circom");

function main() {
  const relayAddress = getRelayAddress();
  const regexDef = `(\\r\\n|^)to:${relayAddressRegexEscaped()}(\\r\\n)`;

  // 1. decomposed spec (same shape as the v1.5 match-only ToPresence spec)
  const spec = { parts: [{ is_public: false, regex_def: regexDef }] };
  fs.writeFileSync(SPEC_PATH, JSON.stringify(spec, null, 2) + "\n");
  console.log(`[gen-regexes] ${path.relative(CIRCUITS_DIR, SPEC_PATH)} <- ${regexDef} (relay: ${relayAddress})`);

  // 2. regenerate the circom circuit (match-only: no reveal -> -g false)
  execFileSync(
    "zk-regex",
    ["decomposed", "-d", SPEC_PATH, "-c", CIRCOM_PATH, "-t", "ToPresenceRegex", "-g", "false"],
    { stdio: "inherit", cwd: CIRCUITS_DIR }
  );

  // 3. codegen quirk: no-reveal path omits the template's closing brace
  let circom = fs.readFileSync(CIRCOM_PATH, "utf8");
  if (!circom.trimEnd().endsWith("}")) {
    circom = circom.trimEnd() + "\n}\n";
    fs.writeFileSync(CIRCOM_PATH, circom);
    console.log("[gen-regexes] appended missing closing '}' to to_presence_regex.circom (zk-regex 2.3.2 no-reveal quirk)");
  }

  const header = circom.split("\n").find((l) => l.startsWith("// regex:"));
  console.log(`[gen-regexes] done: ${path.relative(CIRCUITS_DIR, CIRCOM_PATH)} (${header})`);
}

main();

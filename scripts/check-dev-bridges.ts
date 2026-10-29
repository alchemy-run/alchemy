/**
 * Audit that every AWS binding, event source and target builder goes through
 * its `alchemy dev` bridge seam (see `.agents/skills/dev-bridges`), so an
 * emulated end and a real-cloud end never meet without a bridge or a
 * by-name rejection.
 *
 *   node scripts/check-dev-bridges.ts               # fail on any violation
 *   node scripts/check-dev-bridges.ts --inventory   # also print the surface
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "packages", "aws", "src");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") ? [path] : [];
  });

const sources = files(root).map((path) => ({
  file: relative(root, path),
  text: readFileSync(path, "utf8"),
}));

/** Connect services by whether their endpoint can be reached from outside the VPC. */
const CONNECT_ENDPOINTS: Record<string, "private" | "public-capable"> = {
  DAX: "private",
  DocDB: "private",
  ElastiCache: "private",
  MemoryDB: "private",
  DSQL: "public-capable",
  Kafka: "public-capable",
  RDS: "public-capable",
  Redshift: "public-capable",
  RedshiftServerless: "public-capable",
};

const violations: string[] = [];
const inventory: Record<string, string[]> = {
  "call (Direct: withCredentials)": [],
  "event, Lambda target (Stub host: wireEventSource)": [],
  "event, other target (Reject: requireSameSide)": [],
  "connect, private endpoint (Reject in Bind)": [],
  "connect, public-capable endpoint (Direct network)": [],
};

for (const { file, text } of sources) {
  if (file === "AWSBindings.ts" || file.startsWith("Local/")) continue;

  // Call: an operation bound to a host resolves its credentials per call.
  const distilled = /^import \* as \w+ from "@distilled\.cloud\/aws\/[a-z0-9-]+";/m.test(text);
  const binds = /AWSBindings\.Bind\b/.test(text);
  if (distilled && binds) {
    if (text.includes("withCredentials(")) inventory["call (Direct: withCredentials)"]!.push(file);
    else violations.push(`${file}: binds a host and calls AWS without AWSBindings.withCredentials`);
  }

  // Event: every Lambda event source and Lambda target builder wires through the stub seam.
  const lambdaEventSource = text.includes("eventSourceHost(") && file !== "Lambda/Function.ts";
  const lambdaTargetBuilder =
    /\btoLambda\b/.test(text) &&
    (file === "EventBridge/ToLambda.ts" || file === "Pipes/builders.ts");
  if (lambdaEventSource || lambdaTargetBuilder) {
    // Delegating to EventBridge's `toLambda` (which wires through it) counts.
    if (text.includes("wireEventSource(") || text.includes('from "../EventBridge/ToLambda.ts"')) {
      inventory["event, Lambda target (Stub host: wireEventSource)"]!.push(file);
    } else {
      violations.push(`${file}: wires a Lambda event source without wireEventSource`);
    }
  }

  // Event: builders targeting anything else reject a cross-side route.
  const otherTargetBuilder =
    /^EventBridge\/To(?!Lambda)\w+\.ts$/.test(file) || file === "Pipes/builders.ts";
  if (otherTargetBuilder) {
    if (text.includes("requireSameSide(")) {
      inventory["event, other target (Reject: requireSameSide)"]!.push(file);
    } else {
      violations.push(`${file}: routes events to a non-Lambda target without requireSameSide`);
    }
  }

  // Connect: every Connect service is classified, so Bind knows what to reject.
  for (const [, service] of text.matchAll(/Binding\.Service<\w+>\("AWS\.(\w+)\.Connect\w*"\)/g)) {
    const kind = CONNECT_ENDPOINTS[service!];
    if (kind === undefined) {
      violations.push(
        `${file}: AWS.${service}.Connect is not classified in CONNECT_ENDPOINTS (and Bind's PRIVATE_ENDPOINT_SERVICES)`,
      );
    } else {
      inventory[
        kind === "private"
          ? "connect, private endpoint (Reject in Bind)"
          : "connect, public-capable endpoint (Direct network)"
      ]!.push(file);
    }
  }
}

// Bind's rejection list must match the private services here.
const bindings = readFileSync(join(root, "AWSBindings.ts"), "utf8");
const listed = /PRIVATE_ENDPOINT_SERVICES = new Set\(\[([^\]]*)\]\)/.exec(bindings)?.[1] ?? "";
const privateInBind = new Set([...listed.matchAll(/"(\w+)"/g)].map(([, name]) => name));
for (const [service, kind] of Object.entries(CONNECT_ENDPOINTS)) {
  if ((kind === "private") !== privateInBind.has(service)) {
    violations.push(`AWSBindings.ts: PRIVATE_ENDPOINT_SERVICES disagrees on ${service}`);
  }
}

if (process.argv.includes("--inventory")) {
  for (const [kind, members] of Object.entries(inventory)) {
    console.log(`${kind}: ${members.length}`);
    for (const member of members) console.log(`  ${member}`);
  }
}

if (violations.length > 0) {
  console.error(`dev-bridges: ${violations.length} member(s) bypass their seam:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("dev-bridges: every AWS binding, event source and target builder uses its seam");

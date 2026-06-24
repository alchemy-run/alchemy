#!/usr/bin/env bun
/**
 * Provision a throwaway Cloudflare *temporary preview account* and run the
 * Alchemy test suite against it — no real Cloudflare login or long-lived API
 * token required.
 *
 * It uses the public, proof-of-work-gated provisioning API (the same flow as
 * `wrangler deploy --temporary`, see https://blog.cloudflare.com/temporary-accounts/)
 * exposed by `@distilled.cloud/cloudflare/provisioning`, then runs vitest with
 * the temporary account's credentials injected.
 *
 * The temporary account self-expires (~60 min), so there is nothing to clean
 * up afterwards.
 *
 * Usage:
 *   # run the Cloudflare suite against a fresh temporary account (default)
 *   bun scripts/test-with-temporary-account.ts
 *
 *   # target a narrower path / forward extra args to vitest
 *   bun scripts/test-with-temporary-account.ts test/Cloudflare/KV/Namespace.test.ts
 *
 * Note: a temporary account is brand new and unentitled — it has no zones and
 * no plan features, so zone-scoped and entitlement-gated suites will fail.
 * It is best used to smoke-test account-scoped resources (KV, R2, Queues,
 * Workers, D1, …). Pass an explicit path to scope the run.
 */
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { Effect } from "effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Provisioning from "@distilled.cloud/cloudflare/provisioning";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Cloudflare's terms accepted by provisioning a temporary account.
const TERMS = {
  termsOfService: "https://www.cloudflare.com/terms/",
  privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
} as const;

// Upper bound on total proof-of-work (k*g hashes), mirroring wrangler's cap so
// a malformed/hostile challenge can't make us spin forever.
const POW_MAX_ITERATIONS = 64_000_000;

// Sensitive fields decode to `Redacted<string>` at runtime even though the
// static type says `string` — reveal so the token is actually usable.
const reveal = (value: string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * Provision a temporary preview account: mint a proof-of-work challenge, solve
 * it locally (sequential SHA-256 chain), and redeem it for account-scoped
 * credentials. Requires a `Credentials` + `HttpClient` layer; the endpoints are
 * public so the credentials are only a placeholder.
 */
const provisionTemporaryAccount = Effect.gen(function* () {
  const challenge = yield* Provisioning.createTemporaryAccountChallenge({});

  const seedBytes = Buffer.from(challenge.seed, "base64url").length;
  if (
    !Number.isInteger(challenge.k) ||
    !Number.isInteger(challenge.g) ||
    challenge.k <= 0 ||
    challenge.g <= 0 ||
    challenge.k * challenge.g > POW_MAX_ITERATIONS ||
    seedBytes !== 32
  ) {
    return yield* Effect.die(
      new Error(
        `Unsupported proof-of-work challenge (k=${challenge.k}, g=${challenge.g}, seed=${seedBytes}B)`,
      ),
    );
  }

  // Solve the PoW: chain of k segments of g SHA-256 hashes, checkpoint each
  // boundary, then standard-base64 the concatenated checkpoints.
  const checkpoints = yield* Effect.sync(() => {
    const seed = Buffer.from(challenge.seed, "base64url");
    const acc: Buffer[] = Array.from({ length: challenge.k + 1 });
    let h = createHash("sha256").update(seed).digest();
    acc[0] = h;
    for (let j = 0; j < challenge.k; j++) {
      for (let i = 0; i < challenge.g; i++) {
        h = createHash("sha256").update(h).digest();
      }
      acc[j + 1] = h;
    }
    return Buffer.concat(acc).toString("base64");
  });

  const result = yield* Provisioning.createTemporaryAccount({
    termsOfService: TERMS.termsOfService,
    privacyPolicy: TERMS.privacyPolicy,
    acceptTermsOfService: "yes",
    challengeToken: challenge.challengeToken,
    solution: { checkpoints },
  });

  return {
    accountId: result.account.id,
    accountName: result.account.name,
    apiToken: reveal(result.account.apiToken),
    expiresAt: result.account.expiresAt,
    claimUrl: result.claim.url,
  };
});

const main = async () => {
  console.log(
    `${DIM}Provisioning a temporary Cloudflare account (solving proof-of-work)…${RESET}`,
  );

  const creds = await Effect.runPromise(
    provisionTemporaryAccount.pipe(
      // Public endpoints ignore auth, but the SDK client always attaches a
      // Bearer token — provide a placeholder.
      Effect.provide(
        fromApiToken({
          apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "unauthenticated",
          apiBaseUrl: process.env.CLOUDFLARE_API_BASE_URL,
        }),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  );

  console.log(
    `${GREEN}✓${RESET} account ${BOLD}${creds.accountId}${RESET} (${creds.accountName}) ${DIM}expires ${creds.expiresAt}${RESET}`,
  );
  console.log(`${DIM}  claim: ${creds.claimUrl}${RESET}`);
  console.log(
    `${DIM}Running Alchemy test suite against the temporary account…${RESET}\n`,
  );

  // Default to the Cloudflare suite; allow overriding via CLI args.
  const passthrough = process.argv.slice(2);
  const vitestArgs = passthrough.length > 0 ? passthrough : ["test/Cloudflare"];

  const proc = Bun.spawn(["bunx", "vitest", "run", ...vitestArgs], {
    cwd: nodePath.resolve(import.meta.dir, "../packages/alchemy"),
    env: {
      ...process.env,
      // Force Alchemy's Cloudflare auth to read credentials from the
      // environment (CI path) under a throwaway profile so it never picks up a
      // stored profile pointing at a real account.
      CI: "true",
      ALCHEMY_PROFILE: "cf-temporary-account",
      CLOUDFLARE_ACCOUNT_ID: creds.accountId,
      CLOUDFLARE_API_TOKEN: creds.apiToken,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    console.log(`\n${GREEN}${BOLD}✓ Test suite passed${RESET}`);
  } else {
    console.log(`\n${RED}${BOLD}✗ Test suite failed (exit ${exitCode})${RESET}`);
  }
  process.exitCode = exitCode;
};

void main();

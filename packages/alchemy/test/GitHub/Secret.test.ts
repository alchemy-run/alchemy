import * as GitHub from "@/GitHub";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deploying a secret needs an owner + repository the token can write to.
const owner = process.env.GITHUB_TEST_OWNER ?? "";
const repository = process.env.GITHUB_TEST_REPOSITORY ?? "";

// `list()` for GitHub.Secret is non-listable (pattern (e) in
// processes/list-support.md): secrets are keyed by their parent
// (owner/repository[, environment]/name) which arrive as props, there is no
// ambient owner/repo scope, and GitHub exposes no account-wide enumeration —
// only list-secrets *within* a specific repo. So `list()` always returns `[]`,
// even when a secret exists in the cloud.
test.provider(
  "list returns an empty array for non-enumerable GitHub secrets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // When a writable repo is available, prove `list()` still returns `[]`
      // even with a real secret deployed (it is not enumerable without scope).
      if (owner && repository) {
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GitHub.Secret("ListSecret", {
              owner,
              repository,
              name: "ALCHEMY_LIST_TEST",
              value: Redacted.make("list-test-value"),
            }).pipe(destroy());
          }),
        );
      }

      const provider = yield* Provider.findProvider(GitHub.Secret);
      const all = yield* provider.list();

      expect(all).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

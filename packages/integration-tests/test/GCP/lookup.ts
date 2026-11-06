import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import type { ScratchStack } from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/**
 * Deploy one Secret Manager secret per looked-up value, annotated with the
 * value it was given, and check:
 *
 * - every secret carries the value `expected` names, read back from GCP;
 * - a second plan of the same program is a noop (a lookup re-resolves to
 *   the same resource);
 * - destroying the stack removes the secrets and nothing else.
 *
 * `values` is a thunk so each deploy and plan builds fresh lookups.
 */
export const expectLookupConsumers = Effect.fn(function* (
  stack: ScratchStack,
  values: () => Record<string, Input<string>>,
  expected: Record<string, string>,
) {
  const program = Effect.gen(function* () {
    // Resolved to the secret names by the deploy.
    const names: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values())) {
      const secret = yield* GCP.SecretManager.Secret(`lookup-${key}`, {
        annotations: { value },
      });
      names[key] = secret.name;
    }
    return names;
  });

  const names = yield* stack.deploy(program);
  for (const [key, name] of Object.entries(names)) {
    const secret = yield* secretmanager.getProjectsSecrets({ name: name as string });
    expect({ [key]: secret.annotations?.value }).toEqual({ [key]: expected[key] });
  }

  const plan = yield* stack.plan(program);
  for (const key of Object.keys(names)) {
    expect({ [key]: plan.resources[`lookup-${key}`]?.action }).toEqual({ [key]: "noop" });
  }

  yield* stack.destroy();
});

/**
 * Deploy one secret per lookup of a resource that doesn't exist, and check
 * every deploy fails with `LookupNotFoundError`. Every lookup is tried, and
 * the assertion names each one that failed some other way.
 */
export const expectAllMissing = Effect.fn(function* (
  stack: ScratchStack,
  lookups: Record<string, Output.Output<unknown>>,
) {
  const mismatches: Record<string, string> = {};
  for (const [id, value] of Object.entries(lookups)) {
    const exit = yield* Effect.exit(
      stack.deploy(
        GCP.SecretManager.Secret(id, { annotations: { value: Output.interpolate`${value}` } }),
      ),
    );
    const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "deploy succeeded";
    if (!pretty.includes("LookupNotFoundError")) {
      mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
    }
  }
  expect(mismatches).toEqual({});
  yield* stack.destroy();
});

// Fields GCP changes on every read or write.
const volatile = /^(etag|updateTime|endTime|.*[fF]ingerprint)$/;

// A create's response can carry more digits than a later read.
const sameInstant = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(a) &&
  Math.abs(Date.parse(a) - Date.parse(b)) < 1000;

// The forms GCP and a deploy may each give the same value in: a JSON
// document GCP re-serialized with its keys reordered, a resource path
// naming the project by number instead of id, an empty list for none.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === "string" && /^[[{]/.test(v)) {
      try {
        return JSON.parse(canonical(JSON.parse(v)));
      } catch {
        return v;
      }
    }
    if (typeof v === "string") return v.replace(/(^|\/)projects\/[^/]+\//, "$1projects/_/");
    if (Array.isArray(v)) return v.length === 0 ? undefined : v;
    return v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v;
  }) ?? "undefined";

/**
 * Look a just-deployed resource up from a second stack that only plans,
 * and check its attributes match the ones the deploy returned. The plan
 * resolves the lookup against the real cloud; nothing is written.
 *
 * Etags, fingerprints and update times are skipped; `ignore` names fields
 * that track progress the deploy didn't wait for (a rollout's status).
 */
export const expectFound = Effect.fn(function* (
  lookup: Output.Output<unknown> | object,
  expected: object,
  options: { readonly ignore?: ReadonlyArray<string> } = {},
) {
  const probe = Core.scratchStack({ providers: GCP.providers() }, "GcpLookupProbe");
  // A just-created resource can read as missing for a few seconds.
  const plan = yield* probe
    .plan(
      GCP.SecretManager.Secret("lookup-probe", {
        annotations: {
          value: Output.map(lookup as Output.Output<unknown>, (attrs) => JSON.stringify(attrs)),
        },
      }),
    )
    .pipe(
      Effect.catchDefect((defect) =>
        Predicate.isTagged(defect, "LookupNotFoundError")
          ? Effect.fail(defect)
          : Effect.die(defect),
      ),
      Effect.retry({ times: 6, schedule: Schedule.spaced("5 seconds") }),
    );
  const node = plan.resources["lookup-probe"] as { props: { annotations: { value: string } } };
  const found = JSON.parse(node.props.annotations.value) as Record<string, unknown>;
  const want = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
  const mismatches: Record<string, { lookup: unknown; deploy: unknown }> = {};
  for (const [key, value] of Object.entries(want)) {
    if (volatile.test(key) || options.ignore?.includes(key)) continue;
    if (sameInstant(found[key], value)) continue;
    if (canonical(found[key]) !== canonical(value)) {
      mismatches[key] = { lookup: found[key], deploy: value };
    }
  }
  expect(mismatches).toEqual({});
});

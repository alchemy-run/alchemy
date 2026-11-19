import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

// Fields GitHub changes on its own after a write.
const volatile = /^(updatedAt)$/;

// Redacted values compare by what they hold.
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_, v: unknown) => (Redacted.isRedacted(v) ? Redacted.value(v) : v)),
  );

/**
 * Look a just-deployed resource up from a second stack that only plans,
 * and check its attributes match the ones the deploy returned. The plan
 * resolves the lookup against GitHub; nothing is written: the probe is a
 * label that plans as a create, which reads nothing.
 *
 * `updatedAt` is skipped; `ignore` names fields a lookup can't know.
 */
export const expectFound = Effect.fn(function* (
  lookup: Output.Output<unknown> | object,
  expected: object,
  options: { readonly ignore?: ReadonlyArray<string> } = {},
) {
  const probe = Core.scratchStack(
    { providers: GitHub.providers({ baseUrl: "github.com" }) },
    "GitHubLookupProbe",
  );
  // A just-created resource can read as missing for a few seconds.
  const plan = yield* probe
    .plan(
      GitHub.Label("lookup-probe", {
        owner: "alchemy-run-test",
        repository: "lookup-probe",
        name: "lookup-probe",
        description: Output.map(lookup as Output.Output<unknown>, (attrs) =>
          JSON.stringify(plain(attrs)),
        ),
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
  const node = plan.resources["lookup-probe"] as { props: { description: string } };
  const found = JSON.parse(node.props.description) as Record<string, unknown>;
  const want = plain(expected) as Record<string, unknown>;
  const mismatches: Record<string, { lookup: unknown; deploy: unknown }> = {};
  for (const [key, value] of Object.entries(want)) {
    if (volatile.test(key) || options.ignore?.includes(key)) continue;
    if (JSON.stringify(found[key]) !== JSON.stringify(value)) {
      mismatches[key] = { lookup: found[key], deploy: value };
    }
  }
  expect(mismatches).toEqual({});
});

/** The owner and repository a GitHub web or API URL points into. */
export const repoOf = (url: string) => {
  const [owner, repository] = new URL(url).pathname
    .replace(/^\/repos\//, "/")
    .split("/")
    .filter((part) => part.length > 0);
  return { owner: owner!, repository: repository! };
};

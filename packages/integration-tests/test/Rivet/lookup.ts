import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { expect } from "@alchemy.run/test";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

// Fields Rivet changes on its own after a write.
const volatile = /^(updatedAt)$/;

// Redacted values compare by what they hold.
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_, v: unknown) => (Redacted.isRedacted(v) ? Redacted.value(v) : v)),
  );

/**
 * Look a just-deployed resource up from a second stack that only plans,
 * and check its attributes match the ones the deploy returned. The plan
 * resolves the lookup against the control plane; nothing is written: the
 * probe is a Docker volume that doesn't exist, which only reads as missing.
 * (Rivet resources have no free-form prop to carry the attributes.)
 *
 * `ignore` names fields a lookup can't know (what the deploy hosts).
 */
export const expectFound = Effect.fn(function* (
  lookup: Output.Output<unknown> | object,
  expected: object,
  options: { readonly ignore?: ReadonlyArray<string> } = {},
) {
  const probe = Core.scratchStack(
    { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) },
    "RivetLookupProbe",
  );
  // A just-created resource can read as missing for a few seconds.
  const plan = yield* probe
    .plan(
      Docker.Volume("lookup-probe", {
        labels: {
          value: Output.map(lookup as Output.Output<unknown>, (attrs) =>
            JSON.stringify(plain(attrs)),
          ),
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
  const node = plan.resources["lookup-probe"] as { props: { labels: { value: string } } };
  const found = JSON.parse(node.props.labels.value) as Record<string, unknown>;
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

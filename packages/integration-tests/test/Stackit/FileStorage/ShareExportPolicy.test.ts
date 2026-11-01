import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observePolicy } from "./fileStorage.ts";

const { test } = makeStackitTest();

// A policy costs nothing and needs no pool, so this suite runs ungated.
const options = {
  tags: stackitTags("filestorage", "shareexportpolicy"),
  timeout: 240_000,
} as const;

const policyOf = (props: Stackit.FileStorage.ShareExportPolicyProps) =>
  Stackit.FileStorage.ShareExportPolicy("PolicyUnderTest", props);

const expectPresent = <A>(observed: A | "gone"): Exclude<A, "gone"> => {
  expect(observed).not.toEqual("gone");
  return observed as Exclude<A, "gone">;
};

test.provider(
  "create, update and delete a policy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        labels: { env: "test" },
        rules: [
          { order: 2, ipAcl: ["192.0.2.0/24"], readOnly: true, description: "everyone" },
          { order: 1, ipAcl: ["192.0.2.10/32"], superUser: false },
        ],
      } satisfies Stackit.FileStorage.ShareExportPolicyProps;
      const created = yield* stack.deploy(policyOf(props));

      expect(created.policyId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.name).toMatch(/^[a-z0-9-]+$/);
      expect(created.labels).toEqual({ env: "test" });
      expect(created.sharesUsingExportPolicy ?? 0).toEqual(0);
      // By `order`, with the API's defaults filled in.
      expect(created.rules).toEqual([
        {
          order: 1,
          ipAcl: ["192.0.2.10/32"],
          readOnly: false,
          setUuid: false,
          superUser: false,
        },
        {
          order: 2,
          ipAcl: ["192.0.2.0/24"],
          readOnly: true,
          setUuid: false,
          superUser: true,
          description: "everyone",
        },
      ]);

      // Out of band: the rules and Alchemy's ownership labels.
      const fetched = expectPresent(yield* observePolicy(projectId, region, created.policyId));
      expect(fetched?.name).toEqual(created.name);
      expect(fetched?.rules?.length).toEqual(2);
      expect(fetched?.labels).toMatchObject({ env: "test", "alchemy.id": "PolicyUnderTest" });

      // `list` enumerates it.
      const provider = yield* Provider.findProvider(Stackit.FileStorage.ShareExportPolicy);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.policyId === created.policyId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(policyOf(props));
      expect(plan.resources.PolicyUnderTest).toMatchObject({ action: "noop" });

      // Rules and labels update in place, and the whole list is replaced.
      const updated = yield* stack.deploy(
        policyOf({
          labels: { env: "prod" },
          rules: [{ order: 1, ipAcl: ["198.51.100.0/24"], setUuid: true }],
        }),
      );
      expect(updated.policyId).toEqual(created.policyId);
      expect(updated.rules).toEqual([
        {
          order: 1,
          ipAcl: ["198.51.100.0/24"],
          readOnly: false,
          setUuid: true,
          superUser: true,
        },
      ]);
      const refetched = expectPresent(yield* observePolicy(projectId, region, created.policyId));
      expect(refetched?.rules?.map((rule) => rule.ipAcl)).toEqual([["198.51.100.0/24"]]);
      expect(refetched?.labels).toMatchObject({ env: "prod" });
      expect(refetched?.labels?.env).toEqual("prod");

      // Leaving the rules out removes them from a policy Alchemy manages.
      const emptied = yield* stack.deploy(policyOf({ labels: { env: "prod" } }));
      expect(emptied.rules).toEqual([]);
      const empty = expectPresent(yield* observePolicy(projectId, region, created.policyId));
      expect(empty?.rules ?? []).toEqual([]);

      yield* stack.destroy();
      yield* expectGone(observePolicy(projectId, region, created.policyId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "rules from a binding join the policy's own, and leave with it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const own = { order: 5, ipAcl: ["192.0.2.0/24"] };
      const withClients = (ranges: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const policy = yield* policyOf({ rules: [own] });
          for (const range of ranges) {
            yield* policy.bind`client(${range})`({ clients: [{ ipAcl: [range], readOnly: true }] });
          }
          return policy;
        });

      const bound = yield* stack.deploy(withClients(["198.51.100.0/24", "203.0.113.0/24"]));
      expect(bound.rules.map((rule) => [rule.order, rule.ipAcl])).toEqual([
        [5, ["192.0.2.0/24"]],
        [6, ["198.51.100.0/24"]],
        [7, ["203.0.113.0/24"]],
      ]);
      expect(bound.rules.slice(1).map((rule) => rule.readOnly)).toEqual([true, true]);

      // Out of band: the API holds all three.
      const fetched = expectPresent(yield* observePolicy(projectId, region, bound.policyId));
      expect(fetched?.rules?.length).toEqual(3);

      // The same bindings again are a no-op.
      const plan = yield* stack.plan(withClients(["198.51.100.0/24", "203.0.113.0/24"]));
      expect(plan.resources.PolicyUnderTest).toMatchObject({ action: "noop" });

      // A removed binding takes its client away: nothing stays allowed by accident.
      const narrowed = yield* stack.deploy(withClients(["203.0.113.0/24"]));
      expect(narrowed.policyId).toEqual(bound.policyId);
      const after = expectPresent(yield* observePolicy(projectId, region, bound.policyId));
      expect((after?.rules ?? []).flatMap((rule) => rule.ipAcl ?? []).sort()).toEqual([
        "192.0.2.0/24",
        "203.0.113.0/24",
      ]);

      yield* stack.destroy();
      yield* expectGone(observePolicy(projectId, region, bound.policyId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new name replaces the policy and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const rules = [{ order: 1, ipAcl: ["192.0.2.0/24"] }];
      const first = yield* stack.deploy(policyOf({ name: "alchemy-test-policy-a", rules }));
      expect(first.name).toEqual("alchemy-test-policy-a");

      const plan = yield* stack.plan(policyOf({ name: "alchemy-test-policy-b", rules }));
      expect(plan.resources.PolicyUnderTest).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(policyOf({ name: "alchemy-test-policy-b", rules }));
      expect(second.name).toEqual("alchemy-test-policy-b");
      expect(second.policyId).not.toEqual(first.policyId);
      yield* expectGone(observePolicy(projectId, region, first.policyId));

      yield* stack.destroy();
      yield* expectGone(observePolicy(projectId, region, second.policyId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a foreign policy under an explicit name is reported as unowned, and survives",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-policy-foreign";
      // It has no labels for `pnpm nuke` to find, so it goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        sfs.createShareExportPolicy({ projectId, region, name }),
        (foreign) =>
          Effect.gen(function* () {
            const policyId = foreign.shareExportPolicy?.id;
            expect(policyId).toEqual(expect.any(String));

            const error = yield* stack.deploy(policyOf({ name })).pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");

            // Nothing touched it.
            const after = expectPresent(yield* observePolicy(projectId, region, policyId!));
            expect(after?.name).toEqual(name);
          }),
        (foreign) =>
          sfs
            .deleteShareExportPolicy({
              projectId,
              region,
              policyId: foreign.shareExportPolicy?.id ?? "",
            })
            .pipe(Effect.ignore),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

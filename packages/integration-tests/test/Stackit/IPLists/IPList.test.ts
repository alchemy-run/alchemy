import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

/**
 * IP lists are free, so this suite is ungated. A project may hold 3, so the tests
 * take turns. STACKIT accepts one upload a minute, and the provider waits for its
 * turn, so a test with several uploads takes several minutes.
 */
const options = {
  tags: stackitTags("iplists", "iplist"),
  timeout: 600_000,
  exclusive: "stackit:ip-lists",
} as const;

const observe = (projectId: string, region: string, name: string) =>
  ipLists
    .getIPList({ projectId, region, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, name: string) =>
  observe(projectId, region, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (list) => list === "gone",
      times: 10,
    }),
    Effect.map((list) => expect(list).toEqual("gone")),
  );

test.provider(
  "create, update and delete a list",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const list = (cidrs: string[], labels: Record<string, string>) =>
        Stackit.IPLists.IPList("Lifecycle", { cidrs, labels });

      const created = yield* stack.deploy(
        list(["198.51.100.0/24", "203.0.113.0/24"], { env: "test", keep: "yes" }),
      );
      const name = created.listName;
      expect(name).toMatch(/^[0-9a-z-]+$/);
      expect(created.numberOfIps).toEqual(2);
      expect(created.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(created.labels).toEqual({ env: "test", keep: "yes" });

      // Out of band: the entry count and Alchemy's ownership labels.
      const fetched = yield* ipLists.getIPList({ projectId, region, name });
      expect(fetched.numberOfIps).toEqual(2);
      expect(fetched.contentHash).toEqual(created.contentHash);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "Lifecycle",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        list(["198.51.100.0/24", "203.0.113.0/24"], { env: "test", keep: "yes" }),
      );
      expect(plan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // New content in place: same name, new hash.
      const updated = yield* stack.deploy(list(["198.51.100.0/24"], { env: "test", keep: "yes" }));
      expect(updated.listName).toEqual(name);
      expect(updated.numberOfIps).toEqual(1);
      expect(updated.contentHash).not.toEqual(created.contentHash);

      // New labels alone: the content stays, and the removed label goes.
      const relabeled = yield* stack.deploy(list(["198.51.100.0/24"], { env: "prod" }));
      expect(relabeled.contentHash).toEqual(updated.contentHash);
      const refetched = yield* ipLists.getIPList({ projectId, region, name });
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // Nuke's enumeration finds it.
      const provider = yield* Provider.findProvider(Stackit.IPLists.IPList);
      const all = yield* provider.list();
      expect(all.map((item) => item.listName)).toContain(name);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new name replaces create-first and deletes the old list",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const nameA = "alchemy-test-iplist-a";
      const nameB = "alchemy-test-iplist-b";
      const list = (name: string) =>
        Stackit.IPLists.IPList("Renamed", { name, cidrs: ["198.51.100.0/24"] });

      const created = yield* stack.deploy(list(nameA));
      expect(created.listName).toEqual(nameA);

      const plan = yield* stack.plan(list(nameB));
      expect(plan.resources.Renamed).toMatchObject({ action: "replace" });

      const renamed = yield* stack.deploy(list(nameB));
      expect(renamed.listName).toEqual(nameB);
      yield* expectGone(projectId, region, nameA);

      yield* stack.destroy();

      yield* expectGone(projectId, region, nameB);
    }).pipe(logLevel),
  options,
);

test.provider(
  "recreates a list deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IPLists.IPList("Recreated", { cidrs: ["198.51.100.0/24"] }),
      );
      const name = created.listName;

      yield* ipLists.deleteIPList({ projectId, region, name });
      yield* expectGone(projectId, region, name);

      const recreated = yield* stack.deploy(
        Stackit.IPLists.IPList("Recreated", {
          cidrs: ["198.51.100.0/24", "203.0.113.0/24"],
        }),
      );
      expect(recreated.listName).toEqual(name);
      const fetched = yield* ipLists.getIPList({ projectId, region, name });
      expect(fetched.numberOfIps).toEqual(2);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "refuses to take over a list another logical id owns",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-iplist-foreign";
      // Another logical id stands in for someone else: its labels aren't this resource's.
      const foreign = Stackit.IPLists.IPList("Foreign", { name, cidrs: ["198.51.100.0/24"] });
      const deployed = yield* stack.deploy(foreign);

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* foreign;
            yield* Stackit.IPLists.IPList("Claimant", { name, cidrs: ["203.0.113.0/24"] });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // Nothing was written over it.
      const fetched = yield* ipLists.getIPList({ projectId, region, name });
      expect(fetched.contentHash).toEqual(deployed.contentHash);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

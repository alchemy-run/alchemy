import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as functions from "@distilled.cloud/stackit/functions";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, stackitEnvironment, stackitTags } from "../helpers.ts";
import { noFunctions } from "./helpers.ts";

const { test } = Test.make({ providers: Stackit.providers() });

const options = { tags: stackitTags("functions", "pullcredential"), timeout: 180_000 } as const;

const expectGone = (projectId: string, pullCredentialId: string) =>
  functions.getPullCredential({ projectId, pullCredentialId }).pipe(
    Effect.as("present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => state === "gone",
      times: 10,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

test.provider.skipIf(noFunctions)(
  "create, update in place and delete a pull credential",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const credential = (props: {
        address: string;
        username: string;
        password: string;
        labels?: Record<string, string>;
      }) =>
        Stackit.Functions.PullCredential("LifecycleCredential", {
          address: props.address,
          username: props.username,
          password: Redacted.make(props.password),
          labels: props.labels,
        });

      const created = yield* stack.deploy(
        credential({ address: "ghcr.io", username: "one", password: "secret-one" }),
      );
      expect(created.projectId).toEqual(projectId);
      expect(created.address).toEqual("ghcr.io");
      expect(created.username).toEqual("one");
      expect(created.name.length).toBeLessThanOrEqual(32);
      expect(JSON.stringify(created)).not.toContain("secret-one");

      const fetched = yield* functions.getPullCredential({
        projectId,
        pullCredentialId: created.pullCredentialId,
      });
      expect(fetched).toMatchObject({
        id: created.pullCredentialId,
        name: created.name,
        address: "ghcr.io",
        username: "one",
      });
      expect(fetched.labels?.["alchemy.id"]).toEqual("LifecycleCredential");

      const updated = yield* stack.deploy(
        credential({
          address: "registry.example.com",
          username: "two",
          password: "secret-two",
          labels: { team: "platform" },
        }),
      );
      expect(updated.pullCredentialId).toEqual(created.pullCredentialId);
      expect(updated.labels).toEqual({ team: "platform" });

      const refetched = yield* functions.getPullCredential({
        projectId,
        pullCredentialId: created.pullCredentialId,
      });
      expect(refetched.address).toEqual("registry.example.com");
      expect(refetched.username).toEqual("two");
      expect(refetched.labels?.team).toEqual("platform");

      yield* stack.destroy();
      yield* expectGone(projectId, created.pullCredentialId);
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noFunctions)(
  "a pull credential with an explicit name keeps it, and a rename updates in place",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const credential = (name: string) =>
        Stackit.Functions.PullCredential("NamedCredential", {
          name,
          address: "ghcr.io",
          username: "one",
          password: Redacted.make("secret"),
        });

      const created = yield* stack.deploy(credential("alchemy-test-pull"));
      expect(created.name).toEqual("alchemy-test-pull");

      const renamed = yield* stack.deploy(credential("alchemy-test-pull-2"));
      expect(renamed.pullCredentialId).toEqual(created.pullCredentialId);
      const fetched = yield* functions.getPullCredential({
        projectId,
        pullCredentialId: created.pullCredentialId,
      });
      expect(fetched.name).toEqual("alchemy-test-pull-2");

      yield* stack.destroy();
      yield* expectGone(projectId, created.pullCredentialId);
    }).pipe(logLevel),
  options,
);

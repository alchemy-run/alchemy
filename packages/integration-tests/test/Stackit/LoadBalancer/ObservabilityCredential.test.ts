import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Credentials are free, so this suite is ungated.
const options = {
  tags: stackitTags("loadbalancer", "observabilitycredential"),
  timeout: 300_000,
} as const;

/** Out-of-band: the credential as STACKIT reports it, or `"gone"`. */
const observe = (projectId: string, region: string, credentialsRef: string) =>
  lb.getCredentials({ projectId, region, credentialsRef }).pipe(
    Effect.map(({ credential }) => credential ?? ("gone" as const)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const expectGone = (projectId: string, region: string, credentialsRef: string) =>
  observe(projectId, region, credentialsRef).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (credential) => credential === "gone",
      times: 10,
    }),
    Effect.map((credential) => expect(credential).toEqual("gone")),
  );

test.provider(
  "create, update and delete a credential",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.LoadBalancer.ObservabilityCredential("Metrics", {
          username: "metrics-writer",
          password: Redacted.make("alchemy-test-password-1"),
        }),
      );
      expect(created.credentialsRef).toEqual(expect.any(String));
      expect(created.displayName).toMatch(/^[0-9a-z-]+$/);
      expect(created.username).toEqual("metrics-writer");
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(JSON.stringify(created)).not.toContain("alchemy-test-password-1");

      // Out of band: it exists, and STACKIT doesn't hand the password back.
      const fetched = yield* lb.getCredentials({
        projectId,
        region,
        credentialsRef: created.credentialsRef,
      });
      expect(fetched.credential?.displayName).toEqual(created.displayName);
      expect(fetched.credential?.username).toEqual("metrics-writer");
      expect(JSON.stringify(fetched)).not.toContain("alchemy-test-password-1");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        Stackit.LoadBalancer.ObservabilityCredential("Metrics", {
          username: "metrics-writer",
          password: Redacted.make("alchemy-test-password-1"),
        }),
      );
      expect(plan.resources.Metrics).toMatchObject({ action: "noop" });

      // Update every field in place: the reference stays.
      const updated = yield* stack.deploy(
        Stackit.LoadBalancer.ObservabilityCredential("Metrics", {
          displayName: "alchemy-lb-credential-updated",
          username: "metrics-writer-2",
          password: Redacted.make("alchemy-test-password-2"),
        }),
      );
      expect(updated.credentialsRef).toEqual(created.credentialsRef);
      expect(updated.displayName).toEqual("alchemy-lb-credential-updated");
      expect(updated.username).toEqual("metrics-writer-2");

      const refetched = yield* lb.getCredentials({
        projectId,
        region,
        credentialsRef: created.credentialsRef,
      });
      expect(refetched.credential?.displayName).toEqual("alchemy-lb-credential-updated");
      expect(refetched.credential?.username).toEqual("metrics-writer-2");

      yield* stack.destroy();

      yield* expectGone(projectId, region, created.credentialsRef);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a rotated password alone runs an update and keeps the reference",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.LoadBalancer.ObservabilityCredential("Rotated", {
          username: "metrics-writer",
          password: Redacted.make("alchemy-test-password-1"),
        }),
      );

      const plan = yield* stack.plan(
        Stackit.LoadBalancer.ObservabilityCredential("Rotated", {
          username: "metrics-writer",
          password: Redacted.make("alchemy-test-password-2"),
        }),
      );
      expect(plan.resources.Rotated).toMatchObject({ action: "update" });

      const rotated = yield* stack.deploy(
        Stackit.LoadBalancer.ObservabilityCredential("Rotated", {
          username: "metrics-writer",
          password: Redacted.make("alchemy-test-password-2"),
        }),
      );
      expect(rotated.credentialsRef).toEqual(created.credentialsRef);

      yield* stack.destroy();

      yield* expectGone(projectId, region, created.credentialsRef);
    }).pipe(logLevel),
  options,
);

test.provider(
  "recreates a credential deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        displayName: "alchemy-lb-credential-recreated",
        username: "metrics-writer",
        password: Redacted.make("alchemy-test-password-1"),
      };
      const created = yield* stack.deploy(
        Stackit.LoadBalancer.ObservabilityCredential("Recreated", props),
      );

      yield* lb.deleteCredentials({ projectId, region, credentialsRef: created.credentialsRef });
      yield* expectGone(projectId, region, created.credentialsRef);

      const recreated = yield* stack.deploy(
        Stackit.LoadBalancer.ObservabilityCredential("Recreated", {
          ...props,
          username: "metrics-writer-2",
        }),
      );
      expect(recreated.credentialsRef).not.toEqual(created.credentialsRef);
      expect(recreated.displayName).toEqual(props.displayName);

      const fetched = yield* lb.getCredentials({
        projectId,
        region,
        credentialsRef: recreated.credentialsRef,
      });
      expect(fetched.credential?.username).toEqual("metrics-writer-2");

      yield* stack.destroy();

      yield* expectGone(projectId, region, recreated.credentialsRef);
    }).pipe(logLevel),
  options,
);

test.provider(
  "list enumerates a generated credential and skips a chosen name",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const generated = yield* Stackit.LoadBalancer.ObservabilityCredential("Generated", {
            username: "metrics-writer",
            password: Redacted.make("alchemy-test-password-1"),
          });
          const chosen = yield* Stackit.LoadBalancer.ObservabilityCredential("Chosen", {
            displayName: "alchemy-lb-credential-chosen",
            username: "metrics-writer",
            password: Redacted.make("alchemy-test-password-1"),
          });
          return { generated, chosen };
        }),
      );

      // `list` under-reports the about 3.6% of generated names with no digit in
      // their tail (see `isGeneratedPhysicalName`); a retry draws a new name.
      const provider = yield* Provider.findProvider(Stackit.LoadBalancer.ObservabilityCredential);
      const all = yield* provider.list();
      const refs = all.map((credential) => credential.credentialsRef);
      expect(refs).toContain(deployed.generated.credentialsRef);
      expect(refs).not.toContain(deployed.chosen.credentialsRef);

      yield* stack.destroy();

      yield* expectGone(projectId, region, deployed.generated.credentialsRef);
      yield* expectGone(projectId, region, deployed.chosen.credentialsRef);
    }).pipe(logLevel),
  options,
);

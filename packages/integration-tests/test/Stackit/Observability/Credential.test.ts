import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("observability", "credential"),
  timeout: 2_700_000,
} as const;

/** The instance, plus the credential when props are given. */
const app = (props?: Omit<Stackit.Observability.CredentialProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Observability.Instance("CredentialInstance", {});
    if (props === undefined) return { instance, credential: undefined };
    return {
      instance,
      credential: yield* Stackit.Observability.Credential("CredentialUnderTest", {
        instanceId: instance.instanceId,
        ...props,
      }),
    };
  });

const observeCredential = (projectId: string, instanceId: string, username: string) =>
  observability
    .getCredentials({ projectId, instanceId, username })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const passwordOf = (credential: { readonly password: Redacted.Redacted<string> | undefined }) =>
  Redacted.value(credential.password!);

test.provider.skipIf(slow)(
  "create, limit, replace, recover and delete a credential",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(app({}));
      const instanceId = created.instance.instanceId;
      const credential = created.credential!;

      expect(credential.username).toEqual(expect.any(String));
      expect(Redacted.isRedacted(credential.password)).toEqual(true);
      expect(passwordOf(credential).length).toBeGreaterThan(0);

      // Out of band.
      const fetched = yield* observeCredential(projectId, instanceId, credential.username);
      expect(fetched === "gone" ? "gone" : "present").toEqual("present");

      // `list` enumerates it, by its generated description.
      const provider = yield* Provider.findProvider(Stackit.Observability.Credential);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.username === credential.username)?.description).toEqual(
        credential.description,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({}));
      expect(plan.resources.CredentialUnderTest).toMatchObject({ action: "noop" });

      // A limit updates in place, and the password survives.
      const limited = yield* stack.deploy(app({ remoteWriteLimit: 1000 }));
      expect(limited.credential!.username).toEqual(credential.username);
      expect(passwordOf(limited.credential!)).toEqual(passwordOf(credential));
      expect(limited.credential!.remoteWriteLimit).toEqual(1000);
      const config = yield* observability.getCredentialsRemoteWriteConfig({
        projectId,
        instanceId,
        username: credential.username,
      });
      expect(config.maxLimit).toEqual(1000);

      // What a crash after `createCredentials` leaves: a row still creating, and no copy
      // of the password anywhere. The next deploy finds it by its generated description
      // and recreates it.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "CredentialUnderTest" };
        const row = yield* state.get(key);
        if (row?.status !== "created") {
          return yield* Effect.fail(new Error("Expected a created row"));
        }
        const { attr: _attr, ...rest } = row;
        yield* state.set({
          ...key,
          value: { ...rest, status: "creating" } satisfies CreatingResourceState,
        });
      }).pipe(Effect.provide(stack.state));

      const recovered = yield* stack.deploy(app({}));
      expect(recovered.credential!.username).not.toEqual(credential.username);
      expect(passwordOf(recovered.credential!).length).toBeGreaterThan(0);
      yield* expectGone(observeCredential(projectId, instanceId, credential.username));

      // A new description is a new credential, and the old one goes.
      const replaced = yield* stack.deploy(app({ description: "alchemy test credential" }));
      expect(replaced.credential!.username).not.toEqual(recovered.credential!.username);
      expect(replaced.credential!.description).toEqual("alchemy test credential");
      yield* expectGone(observeCredential(projectId, instanceId, recovered.credential!.username));

      // Removing it from the stack deletes it and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeCredential(projectId, instanceId, replaced.credential!.username));
      const instance = yield* observeInstance(projectId, instanceId);
      expect(instance === "gone" ? "gone" : "present").toEqual("present");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instanceId));
    }).pipe(logLevel),
  options,
);

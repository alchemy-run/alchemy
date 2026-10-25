import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import {
  applicationGone,
  eventually,
  getServicePrincipal,
  purged,
  servicePrincipalGone,
} from "./graph.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Both applications stay deployed across the replacement step: a deploy
// that replaces a resource while removing its old dependency deadlocks.
const program = (props: { app: "First" | "Second"; accountEnabled: boolean; notes: string }) =>
  Effect.gen(function* () {
    const first = yield* Azure.Entra.Application("First");
    const second = yield* Azure.Entra.Application("Second");
    const principal = yield* Azure.Entra.ServicePrincipal("Principal", {
      appId: props.app === "First" ? first.appId : second.appId,
      accountEnabled: props.accountEnabled,
      notes: props.notes,
      tags: ["team:test"],
    });
    return { first, second, principal };
  });

// Entra applications and service principals are free.
test.provider(
  "create, update, replace, and delete an Entra service principal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { first, principal } = yield* stack.deploy(
        program({ app: "First", accountEnabled: true, notes: "v1" }),
      );
      expect(principal.appId).toEqual(first.appId);
      expect(principal.accountEnabled).toEqual(true);
      expect(principal.tags).toEqual(["team:test"]);
      const observed = yield* getServicePrincipal(principal.objectId);
      expect(observed.appId).toEqual(first.appId);
      expect(observed.notes).toEqual("v1");
      expect(observed.tags).toContain("alchemy::id=Principal");
      expect(observed.tags).toContain("team:test");

      // In-place update.
      const { principal: updated } = yield* stack.deploy(
        program({ app: "First", accountEnabled: false, notes: "v2" }),
      );
      expect(updated.objectId).toEqual(principal.objectId);
      expect(updated.accountEnabled).toEqual(false);
      const reobserved = yield* eventually(
        getServicePrincipal(principal.objectId),
        (sp) => sp.notes === "v2",
      );
      expect(reobserved.accountEnabled).toEqual(false);
      expect(reobserved.notes).toEqual("v2");

      // A new appId replaces the service principal.
      const { second, principal: replaced } = yield* stack.deploy(
        program({ app: "Second", accountEnabled: false, notes: "v2" }),
      );
      expect(replaced.objectId).not.toEqual(principal.objectId);
      expect(replaced.appId).toEqual(second.appId);
      expect(yield* servicePrincipalGone(principal.objectId)).toEqual("gone");
      const observedReplacement = yield* getServicePrincipal(replaced.objectId);
      expect(observedReplacement.appId).toEqual(second.appId);

      yield* stack.destroy();
      expect(yield* servicePrincipalGone(replaced.objectId)).toEqual("gone");
      expect(yield* purged(replaced.objectId)).toEqual("gone");
      expect(yield* applicationGone(first.objectId)).toEqual("gone");
      expect(yield* applicationGone(second.objectId)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:azure", "provider:azure:entra", "live"], timeout: 420_000 },
);

import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as git from "@distilled.cloud/stackit/git";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./git.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("git", "authenticationsource"),
  timeout: 1_800_000,
} as const;

/** A public discovery document: the service may fetch it. */
const DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
const SECRET = "not-a-real-client-secret";

const app = (source: Omit<Stackit.Git.AuthenticationSourceProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Git.Instance("AuthInstance", { forceDestroy: true });
    return {
      instance,
      source: yield* Stackit.Git.AuthenticationSource("SourceUnderTest", {
        instanceId: instance.instanceId,
        ...source,
      }),
    };
  });

const props = {
  name: "alchemy-test-sso",
  autoDiscoverUrl: DISCOVERY,
  clientId: "alchemy-test",
  clientSecret: Redacted.make(SECRET),
};

test.provider.skipIf(slow)(
  "create, update, replace and delete an authentication source",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance, source: created } = yield* stack.deploy(app(props));
      expect(created.status).toEqual("Ready");
      expect(created.name).toEqual(props.name);
      expect(created.clientId).toEqual(props.clientId);
      // The secret isn't in the attributes.
      expect(JSON.stringify(created)).not.toContain(SECRET);

      // Out of band.
      const scope = { projectId, instanceId: instance.instanceId };
      const fetched = yield* git.getAuthentication({
        ...scope,
        authenticationId: created.authenticationId,
      });
      expect(fetched.auto_discover_url).toEqual(DISCOVERY);
      expect(fetched.client_id).toEqual(props.clientId);

      // Redeploying unchanged is a no-op, even with a `Redacted` prop.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.SourceUnderTest).toMatchObject({ action: "noop" });

      // The other settings update in place.
      const { source: updated } = yield* stack.deploy(
        app({ ...props, clientId: "alchemy-test-2", scopes: "openid email" }),
      );
      expect(updated.authenticationId).toEqual(created.authenticationId);
      const changed = yield* git.getAuthentication({
        ...scope,
        authenticationId: created.authenticationId,
      });
      expect(changed.client_id).toEqual("alchemy-test-2");
      expect(changed.scopes).toEqual("openid email");

      // A new name is a new source, and the old one is deleted.
      const { source: replaced } = yield* stack.deploy(
        app({ ...props, name: "alchemy-test-sso-2" }),
      );
      expect(replaced.authenticationId).not.toEqual(created.authenticationId);
      const { authentication } = yield* git.listAuthentication(scope);
      expect(authentication.map((source) => source.name)).toEqual(["alchemy-test-sso-2"]);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);

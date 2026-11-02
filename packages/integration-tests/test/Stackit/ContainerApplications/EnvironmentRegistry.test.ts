import * as Stackit from "@alchemy.run/stackit";
import { removeRegistry } from "@alchemy.run/stackit/ContainerApplications/internal";
import { expect } from "@alchemy.run/test";
import * as sca from "@distilled.cloud/stackit/sca";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { registryServers, sharedEnvironment } from "./helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("containerapplications", "environmentregistry"),
  timeout: 300_000,
} as const;

test.provider(
  "create, update in place, replace on a new server, and remove on destroy",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();

      const login = (server: string, username: string) =>
        Stackit.ContainerApplications.EnvironmentRegistry("Lifecycle", {
          environmentId: scope.environmentId,
          server,
          username,
          password: Redacted.make("not-a-real-password"),
        });

      const created = yield* stack.deploy(login("registry-1.alchemy.invalid", "one"));
      expect(created.server).toEqual("registry-1.alchemy.invalid");
      expect(created.consumers).toEqual([]);
      expect(yield* registryServers(scope)).toContain("registry-1.alchemy.invalid");
      expect(JSON.stringify(created)).not.toContain("not-a-real-password");

      const unchanged = yield* stack.plan(login("registry-1.alchemy.invalid", "one"));
      expect(unchanged.resources.Lifecycle).toMatchObject({ action: "noop" });

      const updated = yield* stack.deploy(login("registry-1.alchemy.invalid", "two"));
      expect(updated.username).toEqual("two");
      const { registries } = yield* sca.listEnvironmentRegistries(scope);
      expect(
        registries.find((registry) => registry.server === "registry-1.alchemy.invalid")?.username,
      ).toEqual("two");

      const replaced = yield* stack.deploy(login("registry-2.alchemy.invalid", "two"));
      expect(replaced.server).toEqual("registry-2.alchemy.invalid");
      const servers = yield* registryServers(scope);
      expect(servers).toContain("registry-2.alchemy.invalid");
      expect(servers).not.toContain("registry-1.alchemy.invalid");

      yield* stack.destroy();
      expect(yield* registryServers(scope)).not.toContain("registry-2.alchemy.invalid");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a server already in the environment is refused without adoption",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* sharedEnvironment;
      yield* stack.destroy();
      const server = "foreign.alchemy.invalid";
      yield* Effect.acquireUseRelease(
        sca.updateEnvironmentRegistries({
          ...scope,
          registries: [{ server, username: "theirs", password: "not-a-real-password" }],
        }),
        () =>
          Effect.gen(function* () {
            const error = yield* stack
              .deploy(
                Stackit.ContainerApplications.EnvironmentRegistry("Foreign", {
                  environmentId: scope.environmentId,
                  server,
                  username: "ours",
                  password: "not-a-real-password",
                }),
              )
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");
            expect(yield* registryServers(scope)).toContain(server);
          }),
        () => removeRegistry(scope, server).pipe(Effect.ignore),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** A Worker has no stable egress address, so only the widest range lets it in. */
export const Forge = Stackit.Git.Instance("GitBindingsInstance", {
  acl: ["0.0.0.0/0"],
  featureToggle: { enableLocalLogin: true, pipelines: { enabled: true } },
  forceDestroy: true,
});

export const SEED_USERNAME = "alchemy-bindings-seed";
export const SEED_PASSWORD = "alchemy-Test-Passw0rd-1";

export const SeedUser = Effect.gen(function* () {
  const forge = yield* Forge;
  return yield* Stackit.Git.User("GitBindingsUser", {
    instanceId: forge.instanceId,
    username: SEED_USERNAME,
    email: `${SEED_USERNAME}@example.com`,
    name: "Bindings suite seed",
    password: Redacted.make(SEED_PASSWORD),
  });
});

export const Ci = Effect.gen(function* () {
  const forge = yield* Forge;
  return yield* Stackit.Git.Runner("GitBindingsRunner", {
    instanceId: forge.instanceId,
    labels: ["stackit-docker"],
  });
});

export const Sso = Effect.gen(function* () {
  const forge = yield* Forge;
  return yield* Stackit.Git.AuthenticationSource("GitBindingsSource", {
    instanceId: forge.instanceId,
    name: "alchemy-bindings-sso",
    autoDiscoverUrl: "https://accounts.google.com/.well-known/openid-configuration",
    clientId: "alchemy-test",
    clientSecret: Redacted.make("not-a-real-client-secret"),
  });
});

export const App = Effect.gen(function* () {
  const forge = yield* Forge;
  const user = yield* SeedUser;
  return yield* Stackit.Git.Repository("GitBindingsRepository", {
    instanceUrl: forge.url,
    username: user.username,
    password: Redacted.make(SEED_PASSWORD),
    name: "alchemy-bindings-repo",
  });
});

/**
 * A Cloudflare Worker with every STACKIT Git binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class GitBindingsWorker extends Cloudflare.Worker<GitBindingsWorker>()(
  "StackitGitBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const forge = yield* Forge;
    const runner = yield* Ci;
    const app = yield* App;
    const getInstance = yield* Stackit.Git.GetInstance(forge);
    const listInstances = yield* Stackit.Git.ListInstances(forge);
    const getRunner = yield* Stackit.Git.GetRunner(runner);
    const createUser = yield* Stackit.Git.CreateUser(forge);
    const getUser = yield* Stackit.Git.GetUser(forge);
    const listUsers = yield* Stackit.Git.ListUsers(forge);
    const updateUser = yield* Stackit.Git.UpdateUser(forge);
    const deleteUser = yield* Stackit.Git.DeleteUser(forge);
    const getAuthenticationSource = yield* Stackit.Git.GetAuthenticationSource(forge);
    const listAuthenticationSources = yield* Stackit.Git.ListAuthenticationSources(forge);
    const listFlavors = yield* Stackit.Git.ListFlavors(forge);
    const listRunnerFamilies = yield* Stackit.Git.ListRunnerFamilies(forge);
    const listRunnerRuntimes = yield* Stackit.Git.ListRunnerRuntimes(forge);
    const getRepository = yield* Stackit.Git.GetRepository(app);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-instances":
            return yield* respond(listInstances({}));
          case "/get-runner":
            return yield* respond(getRunner({}));
          case "/create-user":
            return yield* respond(
              createUser({
                username: param("username"),
                email: `${param("username")}@example.com`,
                name: "Created by a binding",
                password: Redacted.make(SEED_PASSWORD),
              }),
            );
          case "/get-user":
            return yield* respond(getUser({ username: param("username") }));
          case "/list-users":
            return yield* respond(listUsers({ page: 1 }));
          case "/update-user":
            return yield* respond(updateUser({ username: param("username"), name: param("name") }));
          case "/delete-user":
            return yield* respond(deleteUser({ username: param("username") }));
          case "/get-authentication-source":
            return yield* respond(getAuthenticationSource({ authenticationId: param("id") }));
          case "/list-authentication-sources":
            return yield* respond(listAuthenticationSources({}));
          case "/list-flavors":
            return yield* respond(listFlavors({}));
          case "/list-runner-families":
            return yield* respond(listRunnerFamilies({}));
          case "/list-runner-runtimes":
            return yield* respond(listRunnerRuntimes({}));
          case "/get-repository":
            return yield* respond(getRepository({}));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Git.GetInstanceHttp,
        Stackit.Git.ListInstancesHttp,
        Stackit.Git.GetRunnerHttp,
        Stackit.Git.CreateUserHttp,
        Stackit.Git.GetUserHttp,
        Stackit.Git.ListUsersHttp,
        Stackit.Git.UpdateUserHttp,
        Stackit.Git.DeleteUserHttp,
        Stackit.Git.GetAuthenticationSourceHttp,
        Stackit.Git.ListAuthenticationSourcesHttp,
        Stackit.Git.ListFlavorsHttp,
        Stackit.Git.ListRunnerFamiliesHttp,
        Stackit.Git.ListRunnerRuntimesHttp,
        Stackit.Git.GetRepositoryHttp,
      ),
    ),
  ),
) {}

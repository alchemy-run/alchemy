import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The generated name is stable, so every run reuses this one environment. */
export const Apps = Stackit.ContainerApplications.Environment("StackitScaBindingsApps", {});

/** The application the bindings act on: a public image, and one instance. */
export const Backend = Effect.gen(function* () {
  const apps = yield* Apps;
  return yield* Stackit.ContainerApplications.Application("StackitScaBindingsBackend", {
    environmentId: apps.environmentId,
    image: "nginxinc/nginx-unprivileged",
    scaling: { type: "manual", instances: 1 },
  });
});

/** A secret and a login for the audit bindings to find. */
export const Secret = Effect.gen(function* () {
  const apps = yield* Apps;
  return yield* Stackit.ContainerApplications.EnvironmentSecret("StackitScaBindingsSecret", {
    environmentId: apps.environmentId,
    key: "alchemy-test-bindings",
    value: "not-a-secret",
  });
});

export const Login = Effect.gen(function* () {
  const apps = yield* Apps;
  return yield* Stackit.ContainerApplications.EnvironmentRegistry("StackitScaBindingsLogin", {
    environmentId: apps.environmentId,
    server: "bindings.alchemy.invalid",
    username: "not-a-user",
    password: "not-a-password",
  });
});

/**
 * A Cloudflare Worker with every Container Applications binding. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the STACKIT error.
 */
export default class ContainerApplicationsBindingsWorker extends Cloudflare.Worker<ContainerApplicationsBindingsWorker>()(
  "StackitScaBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const apps = yield* Apps;
    const backend = yield* Backend;
    const getEnvironment = yield* Stackit.ContainerApplications.GetEnvironment(apps);
    const listEnvironments = yield* Stackit.ContainerApplications.ListEnvironments(apps);
    const listApplications = yield* Stackit.ContainerApplications.ListApplications(apps);
    const listProjectApplications =
      yield* Stackit.ContainerApplications.ListProjectApplications(apps);
    const getOverview = yield* Stackit.ContainerApplications.GetOverview(apps);
    const listSecrets = yield* Stackit.ContainerApplications.ListEnvironmentSecrets(apps);
    const listRegistries = yield* Stackit.ContainerApplications.ListEnvironmentRegistries(apps);
    const getApplication = yield* Stackit.ContainerApplications.GetApplication(backend);
    const getEvents = yield* Stackit.ContainerApplications.GetApplicationEvents(backend);
    const getLogs = yield* Stackit.ContainerApplications.GetApplicationLogs(backend);
    const updateApplication = yield* Stackit.ContainerApplications.UpdateApplication(backend);

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
        switch (url.pathname) {
          case "/get-environment":
            return yield* respond(getEnvironment());
          case "/list-environments":
            return yield* respond(
              listEnvironments().pipe(
                Effect.map(({ items }) => ({ ids: (items ?? []).map((item) => item.id) })),
              ),
            );
          case "/list-applications":
            return yield* respond(
              listApplications().pipe(
                Effect.map(({ items }) => ({ ids: (items ?? []).map((item) => item.id) })),
              ),
            );
          case "/list-project-applications":
            return yield* respond(
              listProjectApplications().pipe(
                Effect.map(({ items }) => ({ ids: (items ?? []).map((item) => item.id) })),
              ),
            );
          case "/get-overview":
            return yield* respond(getOverview());
          case "/list-secrets":
            return yield* respond(
              // Only keys: a value must not leave the Worker in the test's logs.
              listSecrets().pipe(
                Effect.map(({ secrets }) => ({ keys: secrets.map((secret) => secret.key) })),
              ),
            );
          case "/list-registries":
            return yield* respond(
              listRegistries().pipe(
                Effect.map(({ registries }) => ({
                  servers: registries.map((registry) => registry.server),
                })),
              ),
            );
          case "/get-application":
            return yield* respond(
              getApplication().pipe(
                Effect.map(({ id, status, stopped }) => ({
                  id,
                  status: status?.current,
                  stopped,
                })),
              ),
            );
          case "/get-events":
            return yield* respond(
              getEvents().pipe(Effect.map(({ events }) => ({ count: (events ?? []).length }))),
            );
          case "/get-logs":
            return yield* respond(
              Effect.gen(function* () {
                const live = yield* getApplication();
                const instance = live.status?.instances?.[0]?.name ?? "";
                const { logs } = yield* getLogs({ instance, container: "app" });
                return { count: (logs ?? []).length };
              }),
            );
          case "/set-stopped":
            return yield* respond(
              Effect.gen(function* () {
                const live = yield* getApplication();
                const updated = yield* updateApplication({
                  containers: live.containers,
                  displayName: live.displayName,
                  network: live.network,
                  scaling: live.scaling,
                  stopped: url.searchParams.get("stopped") === "true",
                });
                return { id: updated.id };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ContainerApplications.GetEnvironmentHttp,
        Stackit.ContainerApplications.ListEnvironmentsHttp,
        Stackit.ContainerApplications.ListApplicationsHttp,
        Stackit.ContainerApplications.ListProjectApplicationsHttp,
        Stackit.ContainerApplications.GetOverviewHttp,
        Stackit.ContainerApplications.ListEnvironmentSecretsHttp,
        Stackit.ContainerApplications.ListEnvironmentRegistriesHttp,
        Stackit.ContainerApplications.GetApplicationHttp,
        Stackit.ContainerApplications.GetApplicationEventsHttp,
        Stackit.ContainerApplications.GetApplicationLogsHttp,
        Stackit.ContainerApplications.UpdateApplicationHttp,
      ),
    ),
  ),
) {}

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** Airflow's own example DAG with one task. */
export const EXAMPLE_DAG = "example_simplest_dag";

export const BUNDLE = "alchemy-bindings";

const optional = (name: string) => Config.String(name).pipe(Config.option);

/**
 * The instance. With the suite's identity provider env vars, it signs in there, and Airflow's REST
 * API is on; without them, it uses the API's default, and the bindings on that API aren't called.
 */
export const Airflow = Effect.gen(function* () {
  const discoveryEndpoint = yield* optional("STACKIT_TEST_WORKFLOWS_IDP_DISCOVERY");
  const clientId = yield* optional("STACKIT_TEST_WORKFLOWS_IDP_CLIENT_ID");
  const clientSecret = yield* Config.Redacted("STACKIT_TEST_WORKFLOWS_IDP_CLIENT_SECRET").pipe(
    Config.option,
  );
  const audience = yield* optional("STACKIT_TEST_WORKFLOWS_IDP_AUDIENCE");
  return yield* Stackit.Workflows.Instance("WorkflowsBindingsInstance", {
    enableAirflowExampleDags: true,
    dagBundles: [
      {
        type: "git",
        name: BUNDLE,
        url: "https://github.com/apache/airflow",
        branch: "3.1.8",
        subdir: "airflow-core/src/airflow/example_dags",
        auth: { type: "none" },
      },
    ],
    ...(Option.isSome(discoveryEndpoint) &&
    Option.isSome(clientId) &&
    Option.isSome(clientSecret) &&
    Option.isSome(audience)
      ? {
          identityProvider: {
            type: "oauth2",
            name: "keycloak",
            clientId: clientId.value,
            clientSecret: clientSecret.value,
            discoveryEndpoint: discoveryEndpoint.value,
            scope: "openid email",
            apiAudience: [audience.value],
          },
        }
      : {}),
  });
});

/**
 * A Cloudflare Worker with every Workflows binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class WorkflowsBindingsWorker extends Cloudflare.Worker<WorkflowsBindingsWorker>()(
  "StackitWorkflowsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Airflow;
    const getInstance = yield* Stackit.Workflows.GetInstance(instance);
    const listInstances = yield* Stackit.Workflows.ListInstances(instance);
    const listDagBundles = yield* Stackit.Workflows.ListDagBundles(instance);
    const getDagBundle = yield* Stackit.Workflows.GetDagBundle(instance);
    const updateDagBundle = yield* Stackit.Workflows.UpdateDagBundle(instance);
    const getProviderOptions = yield* Stackit.Workflows.GetProviderOptions(instance);

    // Empty until the suite's identity provider env vars are set; those routes aren't called then.
    const client = {
      discoveryEndpoint: yield* Config.String("STACKIT_TEST_WORKFLOWS_IDP_DISCOVERY").pipe(
        Config.withDefault("https://unset.invalid/.well-known/openid-configuration"),
      ),
      clientId: yield* Config.String("STACKIT_TEST_WORKFLOWS_API_CLIENT_ID").pipe(
        Config.withDefault("unset"),
      ),
      clientSecret: yield* Config.Redacted("STACKIT_TEST_WORKFLOWS_API_CLIENT_SECRET").pipe(
        Config.withDefault(Redacted.make("unset")),
      ),
    };
    const triggerDagRun = yield* Stackit.Workflows.TriggerDagRun(instance, client);
    const getDagRun = yield* Stackit.Workflows.GetDagRun(instance, client);
    const listDagRuns = yield* Stackit.Workflows.ListDagRuns(instance, client);
    const listTaskInstances = yield* Stackit.Workflows.ListTaskInstances(instance, client);
    const getDag = yield* Stackit.Workflows.GetDag(instance, client);
    const patchDag = yield* Stackit.Workflows.PatchDag(instance, client);
    const setVariable = yield* Stackit.Workflows.SetVariable(instance, client);
    const setConnection = yield* Stackit.Workflows.SetConnection(instance, client);

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
        const run = url.searchParams.get("run") ?? "";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-instances":
            return yield* respond(listInstances({}));
          case "/list-dag-bundles":
            return yield* respond(listDagBundles({}));
          case "/get-dag-bundle":
            return yield* respond(getDagBundle({ bundleName: BUNDLE }));
          case "/update-dag-bundle":
            return yield* respond(
              updateDagBundle({
                bundleName: BUNDLE,
                body: {
                  type: "git",
                  refreshInterval: Number(url.searchParams.get("interval") ?? "120"),
                },
              }),
            );
          case "/get-provider-options":
            return yield* respond(getProviderOptions({}));
          case "/get-dag":
            return yield* respond(getDag({ dag_id: EXAMPLE_DAG }));
          case "/patch-dag":
            return yield* respond(
              patchDag({
                dag_id: EXAMPLE_DAG,
                is_paused: url.searchParams.get("paused") === "true",
              }),
            );
          case "/set-variable":
            return yield* respond(
              setVariable({
                key: "alchemy_test",
                value: Redacted.make(url.searchParams.get("value") ?? ""),
                description: "alchemy test",
              }),
            );
          case "/set-connection":
            return yield* respond(
              setConnection({
                connection_id: "alchemy_test",
                conn_type: "http",
                host: url.searchParams.get("host") ?? "",
                ...(url.searchParams.has("password")
                  ? { password: Redacted.make(url.searchParams.get("password") ?? "") }
                  : {}),
              }),
            );
          case "/trigger-dag-run":
            return yield* respond(
              triggerDagRun({ dag_id: EXAMPLE_DAG, dag_run_id: run, conf: { from: "alchemy" } }),
            );
          case "/get-dag-run":
            return yield* respond(getDagRun({ dag_id: EXAMPLE_DAG, dag_run_id: run }));
          case "/list-dag-runs":
            return yield* respond(
              listDagRuns({ dag_id: EXAMPLE_DAG, limit: 10, order_by: ["-run_after"] }),
            );
          case "/list-task-instances":
            return yield* respond(listTaskInstances({ dag_id: EXAMPLE_DAG, dag_run_id: run }));
          // The typed error, not a generic one, is what these three pin.
          case "/get-missing-bundle":
            return yield* respond(
              getDagBundle({ bundleName: "alchemy-missing" }).pipe(
                Effect.as("found"),
                Effect.catchTag("NotFound", () => Effect.succeed("NotFound")),
              ),
            );
          case "/get-missing-run":
            return yield* respond(
              getDagRun({ dag_id: EXAMPLE_DAG, dag_run_id: "alchemy-missing" }).pipe(
                Effect.as("found"),
                Effect.catchTag("NotFound", () => Effect.succeed("NotFound")),
              ),
            );
          case "/trigger-duplicate":
            return yield* respond(
              triggerDagRun({ dag_id: EXAMPLE_DAG, dag_run_id: run }).pipe(
                Effect.as("started"),
                Effect.catchTag("Conflict", () => Effect.succeed("Conflict")),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Workflows.GetInstanceHttp,
        Stackit.Workflows.ListInstancesHttp,
        Stackit.Workflows.ListDagBundlesHttp,
        Stackit.Workflows.GetDagBundleHttp,
        Stackit.Workflows.UpdateDagBundleHttp,
        Stackit.Workflows.GetProviderOptionsHttp,
        Stackit.Workflows.TriggerDagRunHttp,
        Stackit.Workflows.GetDagRunHttp,
        Stackit.Workflows.ListDagRunsHttp,
        Stackit.Workflows.ListTaskInstancesHttp,
        Stackit.Workflows.GetDagHttp,
        Stackit.Workflows.PatchDagHttp,
        Stackit.Workflows.SetVariableHttp,
        Stackit.Workflows.SetConnectionHttp,
      ),
    ),
  ),
) {}

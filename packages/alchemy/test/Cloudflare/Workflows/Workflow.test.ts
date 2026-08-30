import { OwnedBySomeoneElse, Unowned } from "@/AdoptPolicy.ts";
import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthConfig.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import {
  ProviderLive,
  Workflow,
  type WorkflowResource,
  type WorkflowResourceAttrs,
  type WorkflowResourceProps,
} from "@/Cloudflare/Workflows/Workflow.ts";
import { generateWorkflowName } from "@/Cloudflare/Workflows/WorkflowName.ts";
import { Provider } from "@/Provider.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const ACCOUNT_ID = "test-account";
const WORKFLOW_ID = "11111111-2222-3333-4444-555555555555";
const WORKFLOW_NAME = "existing-workflow";
const CLASS_NAME = "ExistingWorkflow";
const SCRIPT_NAME = "existing-workflow-host";
const INSTANCE_ID = "0123456789abcdef0123456789abcdef";
const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workflows/${WORKFLOW_NAME}`;

const workflowEnvelope = () => ({
  success: true,
  errors: [],
  messages: [],
  result: {
    id: WORKFLOW_ID,
    name: WORKFLOW_NAME,
    class_name: CLASS_NAME,
    script_name: SCRIPT_NAME,
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    triggered_on: "2026-01-01T00:00:00Z",
    instances: {},
  },
});

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const notFoundResponse = () =>
  response(
    {
      success: false,
      errors: [{ code: 10200, message: "Workflow not found" }],
      messages: [],
      result: null,
    },
    404,
  );

const credentials: CloudflareResolvedCredentials = {
  type: "apiToken",
  apiToken: Redacted.make("test-token"),
  accountId: ACCOUNT_ID,
  source: { type: "stored" },
};

const environment = (
  handle: (request: { method: string; url: string }) => Response,
) => {
  const client = HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, handle(request))),
  );
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
    Layer.succeed(CloudflareEnvironment, Effect.succeed(credentials)),
  );
};

const withProvider = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(ProviderLive()));

const resourceProps: WorkflowResourceProps = {
  workflowName: WORKFLOW_NAME,
  className: CLASS_NAME,
  scriptName: SCRIPT_NAME,
};

const resourceAttrs: WorkflowResourceAttrs = {
  workflowId: WORKFLOW_ID,
  workflowName: WORKFLOW_NAME,
  className: CLASS_NAME,
  scriptName: SCRIPT_NAME,
  accountId: ACCOUNT_ID,
};

describe("Cloudflare.Workflow physical names", () => {
  it("preserves an explicit physical name on an async Worker reference", () => {
    const workflow = Workflow(CLASS_NAME, {
      className: CLASS_NAME,
      workflowName: WORKFLOW_NAME,
    });

    expect(workflow.workflowName).toBe(WORKFLOW_NAME);
  });

  it.effect("derives distinct defaults from stage-scoped Worker names", () =>
    Effect.gen(function* () {
      const development = yield* generateWorkflowName(
        "app-development-worker",
        CLASS_NAME,
      );
      const production = yield* generateWorkflowName(
        "app-production-worker",
        CLASS_NAME,
      );

      expect(development).not.toBe(production);
      expect(development.length).toBeLessThanOrEqual(64);
      expect(production.length).toBeLessThanOrEqual(64);
    }),
  );

  it.effect("deletes only the selected stage's generated Workflow", () => {
    const requests: Array<{ method: string; url: string }> = [];
    return withProvider(
      Effect.gen(function* () {
        const development = yield* generateWorkflowName(
          "app-development-worker",
          CLASS_NAME,
        );
        const production = yield* generateWorkflowName(
          "app-production-worker",
          CLASS_NAME,
        );
        const provider = yield* Provider<WorkflowResource>(
          "Cloudflare.Workflow",
        );
        yield* provider.delete({
          id: CLASS_NAME,
          fqn: CLASS_NAME,
          instanceId: INSTANCE_ID,
          olds: {
            className: CLASS_NAME,
            scriptName: "app-development-worker",
          },
          output: {
            ...resourceAttrs,
            workflowName: development,
            scriptName: "app-development-worker",
          },
          bindings: [],
          session: {} as never,
        });

        expect(requests).toEqual([
          {
            method: "DELETE",
            url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workflows/${development}`,
          },
        ]);
        expect(requests[0]?.url).not.toContain(production);
      }),
    ).pipe(
      Effect.provide(
        environment((request) => {
          requests.push({ method: request.method, url: request.url });
          return response({
            success: true,
            errors: [],
            messages: [],
            result: null,
          });
        }),
      ),
    );
  });

  it.effect(
    "cold-reads an exact existing name as unowned without writing",
    () => {
      const requests: Array<{ method: string; url: string }> = [];
      return withProvider(
        Effect.gen(function* () {
          const provider = yield* Provider<WorkflowResource>(
            "Cloudflare.Workflow",
          );
          const attrs = yield* provider.read!({
            id: CLASS_NAME,
            fqn: CLASS_NAME,
            instanceId: INSTANCE_ID,
            olds: resourceProps,
            output: undefined,
          });

          expect(requests).toEqual([{ method: "GET", url: BASE_URL }]);
          expect(Unowned.is(attrs)).toBe(true);
          expect({ ...attrs }).toEqual(resourceAttrs);
        }),
      ).pipe(
        Effect.provide(
          environment((request) => {
            requests.push({ method: request.method, url: request.url });
            return response(workflowEnvelope());
          }),
        ),
      );
    },
  );

  it.effect(
    "creates an unused explicit name through its exact API path",
    () => {
      const requests: Array<{ method: string; url: string }> = [];
      return withProvider(
        Effect.gen(function* () {
          const provider = yield* Provider<WorkflowResource>(
            "Cloudflare.Workflow",
          );
          const attrs = yield* provider.reconcile({
            id: CLASS_NAME,
            fqn: CLASS_NAME,
            instanceId: INSTANCE_ID,
            news: resourceProps,
            olds: undefined,
            output: undefined,
            bindings: [],
            session: {} as never,
          });

          expect(attrs).toEqual(resourceAttrs);
          expect(requests).toEqual([
            { method: "GET", url: BASE_URL },
            { method: "PUT", url: BASE_URL },
          ]);
        }),
      ).pipe(
        Effect.provide(
          environment((request) => {
            requests.push({ method: request.method, url: request.url });
            return request.method === "GET"
              ? notFoundResponse()
              : response(workflowEnvelope());
          }),
        ),
      );
    },
  );

  it.effect("refuses to replace into an occupied explicit name", () => {
    const requests: Array<{ method: string; url: string }> = [];
    return withProvider(
      Effect.gen(function* () {
        const provider = yield* Provider<WorkflowResource>(
          "Cloudflare.Workflow",
        );
        const error = yield* provider
          .reconcile({
            id: CLASS_NAME,
            fqn: CLASS_NAME,
            instanceId: INSTANCE_ID,
            news: resourceProps,
            olds: undefined,
            output: undefined,
            bindings: [],
            session: {} as never,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(OwnedBySomeoneElse);
        expect(requests).toEqual([{ method: "GET", url: BASE_URL }]);
      }),
    ).pipe(
      Effect.provide(
        environment((request) => {
          requests.push({ method: request.method, url: request.url });
          return response(workflowEnvelope());
        }),
      ),
    );
  });

  it.effect("updates and deletes an adopted exact name", () => {
    const requests: Array<{ method: string; url: string }> = [];
    return withProvider(
      Effect.gen(function* () {
        const provider = yield* Provider<WorkflowResource>(
          "Cloudflare.Workflow",
        );
        const attrs = yield* provider.reconcile({
          id: CLASS_NAME,
          fqn: CLASS_NAME,
          instanceId: INSTANCE_ID,
          news: resourceProps,
          olds: undefined,
          output: resourceAttrs,
          bindings: [],
          session: {} as never,
        });
        yield* provider.delete({
          id: CLASS_NAME,
          fqn: CLASS_NAME,
          instanceId: INSTANCE_ID,
          olds: resourceProps,
          output: attrs,
          bindings: [],
          session: {} as never,
        });

        expect(requests).toEqual([
          { method: "PUT", url: BASE_URL },
          { method: "DELETE", url: BASE_URL },
        ]);
      }),
    ).pipe(
      Effect.provide(
        environment((request) => {
          requests.push({ method: request.method, url: request.url });
          return request.method === "DELETE"
            ? response({
                success: true,
                errors: [],
                messages: [],
                result: null,
              })
            : response(workflowEnvelope());
        }),
      ),
    );
  });
});

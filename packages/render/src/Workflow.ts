import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { RenderDeployFailedError, RenderValidationError } from "./Errors.ts";
import * as Api from "./internal/Api.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import { pollUntil } from "./internal/Poll.ts";
import { toRedacted } from "./internal/Redacted.ts";
import { envVarsToWire } from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { AutoDeployTrigger, EnvVarValueSpec, Region, WorkflowRuntime } from "./Types.ts";

export interface WorkflowProps {
  /** Workflow service name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or sole owner on `/owners`. */
  ownerId?: string;
  /** Optional Render project environment ID (`env-...`) to associate the workflow with. */
  environmentId?: string;
  /** Deployment region (`oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`). Changing it replaces the workflow. */
  region?: Region;
  /** Workflow execution runtime (`"node"`, `"python"`, `"go"`, `"elixir"`, `"ruby"`, `"docker"`). */
  runtime: WorkflowRuntime;
  /** Git repository URL containing the workflow definition. */
  repo: string;
  /** Git branch to build from. */
  branch?: string;
  /** Repository subdirectory where build and run commands execute. */
  rootDirectory?: string;
  /** Build command (required for native runtimes when not using `"docker"`). */
  buildCommand?: string;
  /** Entry command starting the Render Workflow runner. */
  runCommand: string;
  /** Automatic version deployment trigger (`"commit"`, `"checksPass"`, or `"off"`). */
  autoDeployTrigger?: AutoDeployTrigger;
  /** Environment variables configured on the workflow service during creation. */
  envVars?: Record<string, EnvVarValueSpec>;
  /** Deploy a workflow version immediately after reconcile. */
  deployVersion?: boolean;
  /** Poll until the deployed workflow version reaches `"ready"`. */
  waitForVersionCompletion?: boolean;
}

export interface WorkflowAttributes {
  /** Render workflow ID (`wfl-...`). */
  id: string;
  /** Workflow name. */
  name: string;
  /** Workflow slug used as the `<workflow-slug>/<task-name>` prefix for task runs. */
  slug: string;
  /** Owner workspace/user ID. */
  ownerId: string;
  /** Associated Render environment ID, if any. */
  environmentId?: string;
  /** Deployment region. */
  region: string;
  /** Workflow runtime. */
  runtime: WorkflowRuntime;
  /** Source Git repository URL. */
  repo: string;
  /** Git branch, if configured. */
  branch?: string;
  /** Repository subdirectory, if configured. */
  rootDirectory?: string;
  /** Build command, if configured. */
  buildCommand?: string;
  /** Workflow runner command. */
  runCommand: string;
  /** Auto-deploy trigger mode. */
  autoDeployTrigger?: string;
  /** Active default workflow version ID, if available. */
  defaultVersionId?: string;
  /** Redacted environment variables retained in state. */
  envVars: Record<string, Redacted.Redacted<string>>;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface WorkflowLookup {
  /** Look up an existing workflow by ID (`wfl-...`). */
  id?: string;
  /** Look up an existing workflow by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render Workflow executes durable, step-based background tasks from a Git
 * repository with versioned builds and programmatic task invocations via
 * `/v1/task-runs`.
 *
 * **Example:** Node Render Workflow service
 * ```typescript
 * const jobs = yield* Render.Workflow("Jobs", {
 *   name: "background-jobs",
 *   region: "oregon",
 *   runtime: "node",
 *   repo: "https://github.com/org/workflows",
 *   branch: "main",
 *   buildCommand: "pnpm install && pnpm build",
 *   runCommand: "node dist/workflows.js",
 * });
 * ```
 *
 * @resource
 * @product Workflows
 * @category Compute
 */
export interface Workflow extends Resource<
  "Render.Workflow",
  WorkflowProps,
  WorkflowAttributes,
  never,
  Providers,
  WorkflowLookup
> {}

export const Workflow = Resource<Workflow>("Render.Workflow");

type RenderWorkflowModel = RenderSdk.CreateWorkflowResponse;

const listAllWorkflows = (params: { readonly ownerId?: string[]; readonly name?: string[] }) =>
  Api.paginateCursorList(
    (cursor) => RenderSdk.listWorkflows({ ...params, cursor, limit: 100 }),
    (row) => row.workflow,
  );

const mapWorkflow = (
  w: RenderWorkflowModel,
  envVars: Record<string, Redacted.Redacted<string>> = {},
): WorkflowAttributes => ({
  id: w.id,
  name: w.name,
  slug: w.slug ?? w.name,
  ownerId: w.ownerId,
  environmentId: w.environmentId,
  region: w.region,
  runtime: w.buildConfig.runtime,
  repo: w.buildConfig.repo,
  branch: w.buildConfig.branch,
  rootDirectory: w.buildConfig.rootDir,
  buildCommand: w.buildConfig.buildCommand,
  runCommand: w.runCommand,
  autoDeployTrigger: w.autoDeployTrigger,
  defaultVersionId: w.defaultVersionId,
  envVars,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

const validateWorkflowProps = (props: WorkflowProps) => {
  if (!props.runCommand || props.runCommand.trim().length === 0) {
    return Effect.fail(
      new RenderValidationError({
        field: "runCommand",
        message: "Workflow runCommand cannot be empty.",
      }),
    );
  }
  if (
    props.runtime !== "docker" &&
    (!props.buildCommand || props.buildCommand.trim().length === 0)
  ) {
    return Effect.fail(
      new RenderValidationError({
        field: "buildCommand",
        message: `Workflow buildCommand is required for runtime "${props.runtime}".`,
      }),
    );
  }
  return Effect.void;
};

const waitForWorkflowVersionLive = (versionId: string) =>
  pollUntil({
    operation: "workflow version deployment",
    resourceId: versionId,
    check: RenderSdk.getWorkflowVersion({ workflowVersionId: versionId }),
    statusOf: (v) => v.status,
    failIf: (v) => {
      if (v.status === "build_failed" || v.status === "registration_failed") {
        return new RenderDeployFailedError({
          resourceType: "Render.Workflow",
          resourceId: versionId,
          status: v.status,
          message: `Render Workflow version ${versionId} entered terminal status "${v.status}"`,
        });
      }
      return undefined;
    },
    isDone: (v) => v.status === "ready",
  });

const envVarsStateFromProps = (
  envVars: Record<string, EnvVarValueSpec> | undefined,
): Record<string, Redacted.Redacted<string>> => {
  if (!envVars) return {};
  const wire = envVarsToWire(envVars, [], false);
  const out: Record<string, Redacted.Redacted<string>> = {};
  for (const item of wire) {
    if ("value" in item) {
      out[item.key] = toRedacted(item.value);
    }
  }
  return out;
};

export const WorkflowProvider = () =>
  Provider.effect(
    Workflow,
    Effect.succeed({
      stables: ["id", "slug", "region"],
      nuke: {
        dependsOn: ["Render.Environment", "Render.Project"],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const targetRegion = news.region ?? olds.region;
        const prevRegion = olds.region ?? output?.region;
        if (targetRegion !== undefined && prevRegion !== undefined && targetRegion !== prevRegion) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const wf = yield* Api.ignoreNotFound(RenderSdk.getWorkflow({ workflowId: output.id }));
          return wf ? mapWorkflow(wf, output.envVars ?? {}) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
        const list = yield* listAllWorkflows({ ownerId: [ownerId], name: [desiredName] });
        const matched = list.find((w) => w.name === desiredName);
        if (!matched) return undefined;
        const attrs = mapWorkflow(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const wf = yield* Api.ignoreNotFound(RenderSdk.getWorkflow({ workflowId: props.id }));
          return wf ? mapWorkflow(wf) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Api.resolveOwnerId(props.ownerId);
          const all = yield* listAllWorkflows({ ownerId: [ownerId], name: [props.name] });
          const matched = all.find((w) => w.name === props.name);
          return matched ? mapWorkflow(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const all = yield* listAllWorkflows({ ownerId: [ownerId] });
        return all.map((w) => mapWorkflow(w));
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        yield* validateWorkflowProps(news);
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Api.ignoreNotFound(RenderSdk.getWorkflow({ workflowId: output.id }))
          : undefined;
        const envVarsWire = envVarsToWire(news.envVars ?? {}, [], false);
        const buildConfig = {
          runtime: news.runtime,
          repo: news.repo,
          buildCommand: news.buildCommand ?? "",
          ...(news.branch !== undefined ? { branch: news.branch } : {}),
          ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
        };

        let reconciled: RenderWorkflowModel;
        if (!existing) {
          const ownerId = yield* Api.resolveOwnerId(news.ownerId);
          reconciled = yield* RenderSdk.createWorkflow({
            name: desiredName,
            ownerId,
            region: news.region ?? "oregon",
            runCommand: news.runCommand,
            buildConfig,
            ...(news.autoDeployTrigger !== undefined
              ? { autoDeployTrigger: news.autoDeployTrigger }
              : {}),
            ...(envVarsWire.length > 0 ? { envVars: envVarsWire } : {}),
          });
        } else {
          reconciled = yield* RenderSdk.updateWorkflow({
            workflowId: existing.id,
            name: desiredName,
            runCommand: news.runCommand,
            buildConfig,
            ...(news.autoDeployTrigger !== undefined
              ? { autoDeployTrigger: news.autoDeployTrigger }
              : {}),
          });
        }

        if (news.environmentId !== undefined || existing?.environmentId !== undefined) {
          yield* Api.syncResourceEnvironment(
            reconciled.id,
            reconciled.environmentId ?? existing?.environmentId,
            news.environmentId,
          );
          reconciled = yield* RenderSdk.getWorkflow({ workflowId: reconciled.id });
        }

        if (news.deployVersion) {
          yield* RenderSdk.createWorkflowVersion({ workflowId: reconciled.id });
          if (news.waitForVersionCompletion) {
            const versions = yield* RenderSdk.listWorkflowVersions({
              workflowID: [reconciled.id],
              limit: 1,
            });
            const latestId = versions[0]?.workflowVersion?.id;
            if (latestId) {
              yield* waitForWorkflowVersionLive(latestId);
            }
          }
          reconciled = yield* RenderSdk.getWorkflow({ workflowId: reconciled.id });
        }

        return mapWorkflow(reconciled, envVarsStateFromProps(news.envVars));
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Api.deleteIdempotent(RenderSdk.deleteWorkflow({ workflowId: output.id }));
      }),
      logs: Effect.fn(function* ({ output, options }) {
        return yield* renderResourceLogs({
          ownerId: output.ownerId,
          resourceId: output.id,
          options,
        });
      }),
      tail: ({ output }) =>
        renderResourceTail({
          ownerId: output.ownerId,
          resourceId: output.id,
        }),
    }),
  );

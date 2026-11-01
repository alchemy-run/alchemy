import * as convex from "@distilled.cloud/convex/convex";
import * as deploymentApi from "@distilled.cloud/convex/deployment";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { team } from "./Credentials.ts";
import { onDeployment } from "./internal/deployment.ts";
import { previewIdentifier, previewReference } from "./internal/references.ts";
import { createOnce } from "./internal/retry.ts";
import { isOwnershipTag } from "./internal/tags.ts";
import { assertTeam } from "./internal/team.ts";
import type { ProjectAttributes } from "./Project.ts";
import type { Providers } from "./Providers.ts";

export type DeploymentType = "dev" | "prod" | "preview" | "custom";

/** Delete refused because `deletionProtection` is on. */
export class DeploymentProtected extends Data.TaggedError("DeploymentProtected")<{
  readonly message: string;
  readonly deploymentName: string;
}> {}

/** A deployment in state is gone, and only a preview may come back empty. */
export class DeploymentVanished extends Data.TaggedError("DeploymentVanished")<{
  readonly message: string;
  readonly deploymentName: string;
}> {}

/** Convex answered with a local deployment, which this resource doesn't manage. */
export class NotACloudDeployment extends Data.TaggedError("NotACloudDeployment")<{
  readonly message: string;
}> {}

export interface DeploymentProps {
  /**
   * The project this deployment belongs to. Changing it transfers the
   * deployment and keeps its data. Its name and URL stay the same.
   */
  project: Pick<ProjectAttributes, "projectId">;
  /** Deployment type. */
  type: DeploymentType;
  /**
   * Hosting region, such as `aws-eu-west-1`. Changing it replaces the
   * deployment, and the replacement starts with no data.
   * @default the team's default region
   */
  region?: string;
  /**
   * Deployment class, such as `s16`.
   * @default the team's default class
   */
  class?: string;
  /**
   * Identifies the deployment within the project.
   *
   * With no reference, `prod` targets the project's default production
   * deployment, `preview` uses the stage, and `dev` and `custom` use a
   * generated name. For a preview this is an identifier: Convex stores
   * `preview/<normalised value>`.
   */
  reference?: string;
  /** For a `prod` deployment, whether it is the project's default. */
  isDefault?: boolean;
  /** Timestamp in milliseconds when Convex deletes the deployment. */
  expiresAt?: number;
  /**
   * Refuse to delete this deployment. While on, destroying it fails with
   * `DeploymentProtected`. Set it to `false` and deploy before deleting.
   * @default true for `type: "prod"`, otherwise false
   */
  deletionProtection?: boolean;
  /**
   * Pause or resume the deployment. A paused deployment keeps its data, and
   * function calls fail until it resumes. Convex has no API that reports this,
   * so the value is what you last declared, and leaving it out changes nothing.
   */
  paused?: boolean;
}

export interface DeploymentAttributes {
  /** Readable name, such as `playful-otter-123`. Changes if a preview is recreated. */
  deploymentName: string;
  /** Numeric deployment ID. */
  deploymentId: number;
  /** Numeric ID of the owning project. */
  projectId: number;
  /** Deployment type. */
  type: string;
  /** The reference Convex stored. */
  reference: string;
  /** Hosting region. */
  region: string;
  /** Deployment class. */
  class: string;
  /** Convex API URL, ending in `.convex.cloud`. */
  url: string;
  /** HTTP actions URL, ending in `.convex.site`. */
  siteUrl: string;
  /** Whether this is the project's default prod deployment. */
  isDefault: boolean;
  /** Timestamp in milliseconds when Convex deletes the deployment, if ever. */
  expiresAt: number | undefined;
  /** Whether delete is refused. */
  deletionProtection: boolean;
  /** Numeric ID of the owning team. */
  teamId: number;
  /** Whether this resource last paused the deployment. */
  paused: boolean | undefined;
}

export type Deployment = Resource<
  "Convex.Deployment",
  DeploymentProps,
  DeploymentAttributes,
  never,
  Providers
>;

/**
 * A Convex deployment: one database and set of functions in a project.
 * @see https://docs.convex.dev/production/hosting/preview-deployments
 *
 * ### Safety
 * Prod deployments have `deletionProtection` on, so `alchemy destroy` fails
 * rather than deleting their data.
 *
 * Changing `project` transfers the deployment, so it keeps its data, name and
 * URL. Changing `region` replaces it.
 *
 * Previews expire on Convex's side. The next deploy notices and creates a new
 * one, which has a new name and URL and no data.
 *
 * ### Creating a deployment
 * **Example:** Default production deployment
 * ```typescript
 * const prod = yield* Convex.Deployment("Prod", { project, type: "prod" });
 * ```
 *
 * **Example:** One preview per stage, removed by `alchemy destroy`
 * ```typescript
 * const preview = yield* Convex.Deployment("Preview", { project, type: "preview" });
 * ```
 *
 * @resource
 * @product Deployment
 */
export const Deployment = Resource<Deployment>("Convex.Deployment");

type CloudDeployment = convex.PlatformDeploymentResponseCase0;

const cloudOnly = (deployment: convex.PlatformDeploymentResponse) =>
  deployment.kind === "cloud" ? deployment : undefined;

/** The arguments for `create_deployment`, without the project. */
type CreateArgs = Omit<convex.CreateDeploymentRequest, "project_id">;

interface Target {
  /** What to send to `create_deployment`. */
  readonly create: CreateArgs;
  /** The stored reference, or undefined for the default prod deployment. */
  readonly reference: string | undefined;
  /** True when the reference came from the stage, so a match is this resource's own. */
  readonly derived: boolean;
}

const pick = (props: DeploymentProps) => ({
  ...(props.region !== undefined ? { region: props.region } : {}),
  ...(props.class !== undefined ? { class: props.class } : {}),
  ...(props.isDefault !== undefined ? { isDefault: props.isDefault } : {}),
  ...(props.expiresAt !== undefined ? { expiresAt: props.expiresAt } : {}),
});

const targetOf = Effect.fn(function* (id: string, props: DeploymentProps) {
  const type = props.type;
  if (type === "prod" && props.reference === undefined) {
    return {
      create: { type, ...pick(props) },
      reference: undefined,
      derived: false,
    } satisfies Target;
  }
  if (type === "preview") {
    const stage = yield* Stack.use((stack) => Effect.succeed(stack.stage));
    const value = props.reference ?? stage;
    const { identifier, reference } = yield* Effect.sync(() => ({
      identifier: previewIdentifier(value),
      reference: previewReference(value),
    }));
    return {
      create: { type, reference: identifier, ...pick(props) },
      reference,
      derived: props.reference === undefined,
    } satisfies Target;
  }
  const reference =
    props.reference ??
    `${type}/${yield* createPhysicalName({ id, lowercase: true, maxLength: 60, delimiter: "-" })}`;
  return {
    create: { type, reference, ...pick(props) },
    reference,
    derived: props.reference === undefined,
  } satisfies Target;
});

const observe = (projectId: number, reference: string | undefined) =>
  convex
    .getProjectDeployment(
      reference === undefined
        ? { project_id: projectId, defaultProd: true }
        : { project_id: projectId, reference },
    )
    .pipe(
      Effect.map(cloudOnly),
      Effect.catchTag("DeploymentNotFound", () => Effect.undefined),
    );

const byName = (name: string) =>
  convex.getDeployment({ deployment_name: name }).pipe(
    Effect.map(cloudOnly),
    Effect.catchTag("DeploymentNotFound", () => Effect.undefined),
  );

const toAttrs = Effect.fn(function* (
  deployment: CloudDeployment,
  protection: boolean,
  paused: boolean | undefined,
) {
  const urls = yield* onDeployment(deployment.deploymentUrl, deploymentApi.getCanonicalUrls({}));
  return {
    deploymentName: deployment.name,
    deploymentId: deployment.id,
    projectId: deployment.projectId,
    teamId: yield* team,
    type: deployment.deploymentType,
    reference: deployment.reference,
    region: deployment.region,
    class: deployment.class,
    url: urls.convexCloudUrl,
    siteUrl: urls.convexSiteUrl,
    isDefault: deployment.isDefault,
    expiresAt: deployment.expiresAt ?? undefined,
    deletionProtection: protection,
    paused,
  } satisfies DeploymentAttributes;
});

const protectionOf = (props: DeploymentProps) => props.deletionProtection ?? props.type === "prod";

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      return {
        // Dependents treat these as settled, so an update doesn't rotate their keys.
        stables: ["deploymentName", "deploymentId", "url", "siteUrl"],
        nuke: { dependsOn: ["Convex.Project"] },
        diff: Effect.fn(function* ({ news, olds, output }) {
          const newRegion =
            isResolved(news) &&
            news.region !== undefined &&
            news.region !== (output?.region ?? olds?.region);
          if (newRegion) {
            // Refused here rather than at delete, where the replace has already begun.
            if (output?.deletionProtection) {
              return yield* new DeploymentProtected({
                deploymentName: output.deploymentName,
                message: `Replacing deployment ${output.deploymentName} would delete its data, and it has deletionProtection on. Set it to false and deploy first.`,
              });
            }
            // Reference uniqueness means the old one has to go first.
            return { action: "replace", deleteFirst: true } as const;
          }
          if (!isResolved(news)) return undefined;
          // The engine only reads when it has no state, so this is where an
          // expired preview gets noticed. Prod is left alone: recreating it
          // would quietly swap real data for an empty database.
          if (output?.type === "preview") {
            const live = yield* byName(output.deploymentName);
            // Everything but the project changes, so dependents must follow.
            if (live === undefined) return { action: "update", stables: ["projectId"] } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const deployment = yield* byName(output.deploymentName);
            return (
              deployment && (yield* toAttrs(deployment, output.deletionProtection, output.paused))
            );
          }
          if (olds === undefined) return undefined;
          const target = yield* targetOf(id, olds);
          const deployment = yield* observe(olds.project.projectId, target.reference);
          if (deployment === undefined) return undefined;
          const attrs = yield* toAttrs(deployment, protectionOf(olds), olds.paused);
          return target.derived ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const projectId = news.project.projectId;
          const target = yield* targetOf(id, news);

          // Observe. The name comes first, because it survives a transfer that
          // crashed before its state was written.
          let deployment =
            (output !== undefined ? yield* byName(output.deploymentName) : undefined) ??
            (yield* observe(projectId, target.reference));

          // A 404 may mean another team's deployment.
          if (deployment === undefined && output !== undefined) {
            yield* assertTeam(output.teamId, `deployment ${output.deploymentName}`);
          }

          if (deployment === undefined && output !== undefined && news.type !== "preview") {
            return yield* new DeploymentVanished({
              deploymentName: output.deploymentName,
              message: `Deployment ${output.deploymentName} no longer exists, and creating it again would start with no data. Remove it from the stack or recreate it on purpose.`,
            });
          }

          // Ensure. Creating a preview whose identifier exists deletes the
          // existing one, so this only runs after the read above found nothing.
          if (deployment === undefined) {
            yield* session.note(`Creating ${news.type} deployment...`);
            const created = yield* createOnce(
              convex.createDeployment({ project_id: projectId, ...target.create }),
            );
            deployment = cloudOnly(created);
            if (deployment === undefined) {
              return yield* new NotACloudDeployment({
                message: `Convex created a local deployment for project ${projectId}.`,
              });
            }
          }

          // Sync. A transfer keeps the data, name and URL.
          if (deployment.projectId !== projectId) {
            yield* session.note(`Transferring deployment ${deployment.name}...`);
            const name = deployment.name;
            yield* convex.transferDeployment({
              deployment_name: name,
              destinationProjectId: projectId,
            });
            deployment = (yield* byName(name)) ?? deployment;
          }
          const patch = {
            ...(news.class !== undefined && news.class !== deployment.class
              ? { class: news.class }
              : {}),
            ...(news.expiresAt !== undefined && news.expiresAt !== deployment.expiresAt
              ? { expiresAt: news.expiresAt }
              : {}),
            ...(news.isDefault !== undefined && news.isDefault !== deployment.isDefault
              ? { isDefault: news.isDefault }
              : {}),
            ...(news.type !== deployment.deploymentType ? { deploymentType: news.type } : {}),
            ...(target.reference !== undefined && target.reference !== deployment.reference
              ? { reference: target.reference }
              : {}),
          };
          if (Object.keys(patch).length > 0) {
            yield* session.note(`Updating deployment ${deployment.name}...`);
            const name = deployment.name;
            yield* convex.updateDeployment({ deployment_name: name, ...patch });
            deployment = (yield* byName(name)) ?? deployment;
          }
          // Nothing reports whether a deployment is paused, so both calls run
          // on every reconcile and each is safe to repeat.
          if (news.paused === true) {
            yield* onDeployment(deployment.deploymentUrl, deploymentApi.pauseDeployment({}));
          } else if (news.paused === false) {
            yield* onDeployment(deployment.deploymentUrl, deploymentApi.unpauseDeployment({})).pipe(
              Effect.catchTag("UnpauseDeploymentFailed", () => Effect.void),
            );
          }
          return yield* toAttrs(deployment, protectionOf(news), news.paused);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.deletionProtection) {
            return yield* new DeploymentProtected({
              deploymentName: output.deploymentName,
              message: `Deployment ${output.deploymentName} has deletionProtection on. Set it to false and deploy before deleting.`,
            });
          }
          yield* assertTeam(output.teamId, `deployment ${output.deploymentName}`);
          yield* convex
            .deleteDeployment({ deployment_name: output.deploymentName })
            .pipe(Effect.catchTag("DeploymentNotFound", () => Effect.void));
        }),
        // Only deployments in projects carrying an ownership tag.
        list: Effect.fn(function* () {
          const teamId = yield* team;
          const projects = yield* Stream.runCollect(convex.listProjects.items({ team_id: teamId }));
          const owned = Array.from(projects).filter((project) =>
            project.tags?.some(isOwnershipTag),
          );
          const found = yield* Effect.forEach(
            owned,
            (project) => convex.listDeployments({ project_id: project.id }),
            { concurrency: 4 },
          );
          return yield* Effect.forEach(
            found.flat().flatMap((deployment) => cloudOnly(deployment) ?? []),
            (deployment) => toAttrs(deployment, false, undefined),
            { concurrency: 4 },
          );
        }),
      };
    }),
  );

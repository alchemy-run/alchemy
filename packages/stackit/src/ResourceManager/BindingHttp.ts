import * as Output from "alchemy/Output";
import { isResourceOfType } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { Folder } from "./Folder.ts";
import type { Organization } from "./Organization.ts";
import type { Project } from "./Project.ts";

/**
 * Shared HTTP scaffolding for Resource Manager project bindings.
 * NOT exported from index.ts.
 *
 * The role is bound on the project itself, which here is exactly the bound
 * resource: a project is one of the entities STACKIT binds roles on.
 */
export const makeProjectHttpBinding = <I extends { id: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ResourceManager.GetProject`. */
  tag: string;
  /** What the operation needs on the project. */
  access: StackitBindings.Access;
  /** The distilled operation; the project id is injected as `id`. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (project: Project) => ({ id: project.projectId }),
    grants: (project) => [
      StackitBindings.grantOnScope(
        { resourceType: "project", resourceId: project.projectId },
        options.access,
      ),
    ],
  });

/**
 * A binding on a folder, granted on the folder itself: a folder is one of the
 * entities STACKIT binds roles on. Roles bind on its UUID, requests name it by
 * container id.
 */
export const makeFolderHttpBinding = <I extends { containerId: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ResourceManager.GetFolderDetails`. */
  tag: string;
  /** What the operation needs on the folder. */
  access: StackitBindings.Access;
  /** The distilled operation; the folder's container id is injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (folder: Folder) => ({ containerId: folder.containerId }),
    grants: (folder) => [
      StackitBindings.grantOnScope(
        { resourceType: "folder", resourceId: folder.folderId },
        options.access,
      ),
    ],
  });

/** An id at bind time: a literal, or an attribute of another resource. */
type ContainerId = string | Output.Output<string, never>;

/** An organization, or just its id: deploying the resource writes labels on it. */
type OrganizationTarget = Organization | ContainerId;

const organizationIdOf = (organization: OrganizationTarget): ContainerId =>
  isResourceOfType(organization, "Stackit.ResourceManager.Organization")
    ? (organization as Organization).organizationId
    : (organization as ContainerId);

/**
 * Bind on a container that isn't always a resource. `makeHttpBinding` doesn't
 * fit because an organization can be a plain id.
 */
const makeContainerHttpBinding = <T, I, A, E, K extends keyof I>(options: {
  tag: string;
  access: StackitBindings.Access;
  operation: StackitBindings.StackitHttpOp<I, A, E>;
  /** Where the role binds, and the id requests name the container by. */
  container: (target: T) => {
    readonly resourceType: "folder" | "organization";
    readonly grantId: ContainerId;
    readonly id: ContainerId;
  };
  /** The request fields naming the container. */
  fields: (id: string) => { readonly [P in K]: unknown };
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* (target: T) {
      const container = options.container(target);
      const id = Output.isOutput(container.id) ? yield* container.id : Effect.succeed(container.id);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${target})`({
          grants: [
            StackitBindings.grantOnScope(
              { resourceType: container.resourceType, resourceId: container.grantId },
              options.access,
            ),
          ],
        });
      }
      return Effect.fn(options.tag)(function* (request?: Omit<I, K>) {
        const fields = options.fields(yield* id);
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        return yield* run({ ...request, ...fields } as unknown as I);
      });
    });
  });

/** A binding on an organization, granted on the organization. */
export const makeOrganizationHttpBinding = <I, A, E, K extends keyof I>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ResourceManager.GetOrganization`. */
  tag: string;
  /** What the operation needs on the organization. */
  access: StackitBindings.Access;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
  /** The request fields naming the organization. */
  fields: (id: string) => { readonly [P in K]: unknown };
}) =>
  makeContainerHttpBinding({
    ...options,
    container: (organization: OrganizationTarget) => ({
      resourceType: "organization",
      grantId: organizationIdOf(organization),
      id: organizationIdOf(organization),
    }),
  });

/**
 * A listing of what's directly inside a folder or organization, granted on that
 * parent. A string or Output is an organization id.
 */
export const makeParentHttpBinding = <I extends { containerParentId?: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ResourceManager.ListFolders`. */
  tag: string;
  /** What the operation needs on the parent. */
  access: StackitBindings.Access;
  /** The distilled operation; the parent's id is injected as `containerParentId`. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  makeContainerHttpBinding({
    ...options,
    fields: (containerParentId) => ({ containerParentId }),
    container: (parent: Folder | OrganizationTarget) =>
      isResourceOfType(parent, "Stackit.ResourceManager.Folder")
        ? {
            resourceType: "folder",
            grantId: (parent as Folder).folderId,
            id: (parent as Folder).containerId,
          }
        : {
            resourceType: "organization",
            grantId: organizationIdOf(parent as OrganizationTarget),
            id: organizationIdOf(parent as OrganizationTarget),
          },
  });

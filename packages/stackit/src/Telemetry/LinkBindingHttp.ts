import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as StackitBindings from "../StackitBindings.ts";
import type { Link, LinkScope, LinkScopeType } from "./Link.ts";

/**
 * Shared HTTP scaffolding for the bindings on a `Stackit.Telemetry.Link`.
 * NOT exported from index.ts.
 *
 * The operations come in three copies, one per kind of scope, and the role binds on that
 * scope: the project, folder or organization of the link. The permissions are the
 * `x-stackit-authorization` actions in the service's API spec.
 */

/** A binding for one kind of scope was given a link of another. A mistake in the stack. */
export class LinkScopeMismatch extends Data.TaggedError("Stackit.Telemetry.LinkScopeMismatch")<{
  readonly binding: string;
  readonly expected: LinkScopeType;
  readonly actual: LinkScopeType;
  readonly message: string;
}> {}

const scopeTypeOf = (scope: LinkScope | undefined): LinkScopeType =>
  scope === undefined || "projectId" in scope
    ? "project"
    : "folderId" in scope
      ? "folder"
      : "organization";

/**
 * The grant on the link's scope. Deploy-time only. It reads the prop rather than the
 * attribute so two bindings on one scope share one role binding. A link of another kind
 * of scope would pass every check here and 404 at runtime, so it dies at deploy.
 */
const grantOnLink = (tag: string, expected: LinkScopeType, link: Link, permission: string) => {
  const scope: unknown = link.Props?.scope;
  // A whole scope still unresolved can't be inspected: the attribute names it.
  if (Output.isExpr(scope)) {
    return StackitBindings.grantOnScope(
      { resourceType: expected, resourceId: link.scopeId },
      { permissions: [permission] },
    );
  }
  const known = scope as LinkScope | undefined;
  const actual = scopeTypeOf(known);
  if (actual !== expected) {
    throw new LinkScopeMismatch({
      binding: tag,
      expected,
      actual,
      message: `${tag} needs a link whose scope is a ${expected}; ${link.LogicalId} is on a ${actual}`,
    });
  }
  const resourceId =
    known === undefined
      ? undefined
      : "projectId" in known
        ? known.projectId
        : "folderId" in known
          ? known.folderId
          : known.organizationId;
  return StackitBindings.grantOnScope(
    { resourceType: expected, resourceId },
    { permissions: [permission] },
  );
};

interface LinkBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Telemetry.GetProjectLink`. */
  tag: string;
  /** The permission the operation needs on the link's scope. */
  permission: string;
  /** The distilled operation; the link's scope and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** Build a binding over one operation on a project's link. */
export const makeProjectLinkHttpBinding = <I extends { projectId: string; regionId: string }, A, E>(
  options: LinkBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (link: Link) => ({ projectId: link.scopeId, regionId: link.region }),
    grants: (link) => [grantOnLink(options.tag, "project", link, options.permission)],
  });

/** Build a binding over one operation on a folder's link. */
export const makeFolderLinkHttpBinding = <I extends { folderId: string; regionId: string }, A, E>(
  options: LinkBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (link: Link) => ({ folderId: link.scopeId, regionId: link.region }),
    grants: (link) => [grantOnLink(options.tag, "folder", link, options.permission)],
  });

/** Build a binding over one operation on an organization's link. */
export const makeOrganizationLinkHttpBinding = <
  I extends { organizationId: string; regionId: string },
  A,
  E,
>(
  options: LinkBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (link: Link) => ({ organizationId: link.scopeId, regionId: link.region }),
    grants: (link) => [grantOnLink(options.tag, "organization", link, options.permission)],
  });

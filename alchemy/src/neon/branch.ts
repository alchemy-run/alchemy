import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { createNeonApi, type NeonApiOptions } from "./api.ts";
import type * as neon from "./api/types.gen.ts";
import type { NeonProject } from "./project.ts";
import {
  formatConnectionUri,
  formatRole,
  waitForOperations,
  type NeonConnectionUri,
  type NeonRole,
} from "./utils.ts";

export interface NeonBranchProps extends NeonApiOptions {
  /**
   * The project to create the new branch in.
   * This can be a Project object or an ID string.
   */
  project: string | NeonProject;
  /**
   * The name of the branch.
   * @default `${app}-${stage}-${id}`
   */
  name?: string;
  /**
   * Whether the branch is protected.
   * @default false.
   */
  protected?: boolean;
  /**
   * The parent branch to create the new branch from. Default is the project's default branch.
   * This can be a Branch object or an ID string beginning with `br-`.
   */
  parentBranch?: string | NeonBranch | neon.Branch;
  /**
   * A Log Sequence Number (LSN) on the parent branch. The branch will be created with data from this LSN.
   */
  parentLsn?: string;
  /**
   * A timestamp identifying a point in time on the parent branch. The branch will be created with data starting from this point in time.
   * The timestamp must be provided in ISO 8601 format; for example: `2024-02-26T12:00:00Z`.
   */
  parentTimestamp?: string;
  /**
   * The timestamp when the branch is scheduled to expire and be automatically deleted.
   * Must be set by the client following the [RFC 3339, section 5.6](https://tools.ietf.org/html/rfc3339#section-5.6) format with precision up to seconds (such as 2025-06-09T18:02:16Z).
   * Deletion is performed by a background job and may not occur exactly at the specified time.
   *
   * Access to this feature is currently limited to participants in the Early Access Program.
   */
  expiresAt?: string;
  /**
   * The source of initialization for the branch. Valid values are `schema-only` and `parent-data` (default).
   * * `schema-only` - creates a new root branch containing only the schema. Use `parent_id` to specify the source branch. Optionally, you can provide `parent_lsn` or `parent_timestamp` to branch from a specific point in time or LSN. These fields define which branch to copy the schema from and at what point—they do not establish a parent-child relationship between the `parent_id` branch and the new schema-only branch.
   * * `parent-data` - creates the branch with both schema and data from the parent.
   * @default "parent-data"
   */
  initSource?: "schema-only" | "parent-data";
  /**
   * The endpoints to create for the branch.
   *
   * Warning: If you do not configure endpoints, you will not be able to connect to the branch.
   *
   * @example
   * ```ts
   * [
   *  {
   *   type: "read-write",
   *  },
   *  {
   *   type: "read-only",
   *  },
   * ]
   * ```
   */
  endpoints: neon.BranchCreateRequestEndpointOptions[];
}

export interface NeonBranch extends Resource<"neon::Branch"> {
  /**
   * The branch ID. This value is generated when a branch is created. A branch_id value has a br- prefix. For example: br-small-term-683261.
   */
  id: string;
  /**
   * The ID of the project to which the branch belongs.
   */
  projectId: string;
  /**
   * The ID of the parent branch.
   */
  parentBranchId: string | undefined;
  /**
   * A Log Sequence Number (LSN) on the parent branch. The branch will be created with data from this LSN.
   */
  parentLsn: string | undefined;
  /**
   * A timestamp identifying a point in time on the parent branch. The branch will be created with data starting from this point in time.
   * The timestamp must be provided in ISO 8601 format; for example: `2024-02-26T12:00:00Z`.
   */
  parentTimestamp: string | undefined;
  /**
   * The source of initialization for the branch.
   */
  initSource: "schema-only" | "parent-data" | undefined;
  /**
   * The name of the branch.
   */
  name: string;
  /**
   * Whether the branch is protected.
   */
  protected: boolean;
  /**
   * Whether the branch is the default branch.
   */
  default: boolean;
  /**
   * The timestamp when the branch was created.
   */
  createdAt: Date;
  /**
   * The timestamp when the branch was last updated.
   */
  updatedAt: Date;
  /**
   * The timestamp when the branch is scheduled to expire and be automatically deleted.
   * Must be set by the client following the RFC 3339, section 5.6 format with precision up to seconds (such as 2025-06-09T18:02:16Z).
   * Deletion is performed by a background job and may not occur exactly at the specified time.
   */
  expiresAt: Date | undefined;
  /**
   * The endpoints for the branch.
   */
  endpoints: neon.Endpoint[];
  /**
   * The databases for the branch.
   */
  databases: neon.Database[];
  /**
   * The roles for the branch.
   */
  roles: NeonRole[];
  /**
   * The connection URIs for the branch.
   */
  connectionUris: NeonConnectionUri[];
}

export const NeonBranch = Resource(
  "neon::Branch",
  async function (
    this: Context<NeonBranch>,
    id: string,
    props: NeonBranchProps,
  ) {
    const api = createNeonApi(props);
    const name =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);
    const projectId =
      typeof props.project === "string" ? props.project : props.project.id;
    const parentBranchId =
      typeof props.parentBranch === "string"
        ? props.parentBranch
        : props.parentBranch?.id;

    switch (this.phase) {
      case "delete": {
        if (this.output?.id) {
          const res = await api.deleteProjectBranch({
            path: {
              project_id: this.output.projectId,
              branch_id: this.output.id,
            },
            throwOnError: false,
          });
          if (res.error && res.response.status !== 404) {
            throw new Error(`Failed to delete branch: ${res.error.message}`, {
              cause: res.error,
            });
          }
        }
        return this.destroy();
      }
      case "create": {
        const { data } = await api.createProjectBranch({
          path: {
            project_id: projectId,
          },
          body: {
            branch: {
              name,
              protected: props.protected,
              parent_id: parentBranchId,
              parent_lsn: props.parentLsn,
              parent_timestamp: props.parentTimestamp,
              expires_at: props.expiresAt,
              init_source: props.initSource,
            },
            endpoints: props.endpoints,
          },
        });

        // Endpoints have fields that are updated after operations are complete.
        await waitForOperations(api, data.operations);
        const endpoints = await Promise.all(
          data.endpoints.map((endpoint) =>
            api
              .getProjectEndpoint({
                path: {
                  project_id: projectId,
                  endpoint_id: endpoint.id,
                },
              })
              .then((res) => res.data.endpoint),
          ),
        );

        return this({
          id: data.branch.id,
          name: data.branch.name,
          projectId: data.branch.project_id,
          protected: data.branch.protected,
          default: data.branch.default,
          parentBranchId: data.branch.parent_id,
          parentLsn: data.branch.parent_lsn,
          parentTimestamp: data.branch.parent_timestamp,
          initSource: data.branch.init_source as
            | "schema-only"
            | "parent-data"
            | undefined,
          createdAt: new Date(data.branch.created_at),
          updatedAt: new Date(data.branch.updated_at),
          expiresAt: data.branch.expires_at
            ? new Date(data.branch.expires_at)
            : undefined,
          endpoints,
          databases: data.databases,
          roles: data.roles.map(formatRole),
          connectionUris: data.connection_uris?.map(formatConnectionUri) ?? [],
        });
      }
      case "update": {
        if (
          this.output.projectId !== projectId ||
          (parentBranchId && this.output.parentBranchId !== parentBranchId) ||
          (props.parentLsn && this.output.parentLsn !== props.parentLsn) ||
          (props.parentTimestamp &&
            this.output.parentTimestamp !== props.parentTimestamp) ||
          this.output.initSource !== (props.initSource ?? "parent-data")
        ) {
          this.replace();
        }
        const { data } = await api.updateProjectBranch({
          path: {
            project_id: projectId,
            branch_id: this.output.id,
          },
          body: {
            branch: {
              name: name !== this.output.name ? name : undefined, // prevents 400: cannot set branch to the same name
              protected: props.protected ?? false,
              expires_at: props.expiresAt ?? null,
            },
          },
        });
        return this({
          ...this.output,
          name,
          protected: data.branch.protected,
          updatedAt: new Date(data.branch.updated_at),
          expiresAt: data.branch.expires_at
            ? new Date(data.branch.expires_at)
            : undefined,
        });
      }
    }
  },
);

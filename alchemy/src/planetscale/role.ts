import { alchemy } from "../alchemy.ts";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { PlanetScaleClient, type PlanetScaleProps } from "./api/client.gen.ts";
import type { Branch } from "./branch.ts";
import type { Database } from "./database.ts";

/**
 * Properties for creating or updating a PlanetScale PostgreSQL Role
 */
export interface RoleProps extends PlanetScaleProps {
  /**
   * The organization ID where the role will be created
   * Required when using string database name, optional when using Database resource
   */
  organizationId?: string;

  /**
   * The database where the role will be created
   * Can be either a database name (string) or Database resource
   */
  database: string | Database;

  /**
   * The branch where the role will be created
   * Can be either a branch name (string) or Branch resource
   * @default "main"
   */
  branch?: string | Branch;

  /**
   * Time to live in seconds
   */
  ttl?: number;

  /**
   * Roles to inherit from
   */
  inherited_roles?: Array<
    | "pg_checkpoint"
    | "pg_create_subscription"
    | "pg_maintain"
    | "pg_monitor"
    | "pg_read_all_data"
    | "pg_read_all_settings"
    | "pg_read_all_stats"
    | "pg_signal_backend"
    | "pg_stat_scan_tables"
    | "pg_use_reserved_connections"
    | "pg_write_all_data"
    | "postgres"
  >;
}

export interface Role extends Resource<"planetscale::Role">, RoleProps {
  /**
   * The unique identifier for the role
   */
  id: string;

  /**
   * The name of the role
   */
  name: string;

  /**
   * The timestamp when the role expires (ISO 8601 format)
   */
  expiresAt: string;

  /**
   * The host URL for database connection
   */
  host: string;

  /**
   * The username for database authentication
   */
  username: string;

  /**
   * The encrypted password for database authentication
   */
  password: Secret<string>;
}

export const Role = Resource(
  "planetscale::Role",
  async function (
    this: Context<Role, RoleProps>,
    _id: string,
    props: RoleProps,
  ): Promise<Role> {
    const api = new PlanetScaleClient(props);
    const organization =
      typeof props.branch === "object"
        ? props.branch.organizationId
        : typeof props.database === "object"
          ? props.database.organizationId
          : props.organizationId;
    const database =
      typeof props.database === "string" ? props.database : props.database.name;
    const branch =
      typeof props.branch === "string"
        ? props.branch
        : (props.branch?.name ?? "main");
    if (!organization) {
      throw new Error("Organization ID is required");
    }

    switch (this.phase) {
      case "delete": {
        if (this.output?.id) {
          const res = await api.organizations.databases.branches.roles.delete({
            path: {
              organization,
              database,
              branch,
              id: this.output.id,
            },
            result: "full",
          });
          if (res.error && res.error.status !== 404) {
            throw new Error("Failed to delete role", { cause: res.error });
          }
        }
        return this.destroy();
      }
      case "create": {
        const { kind } = await api.organizations.databases.get({
          path: {
            organization,
            name: database,
          },
        });
        if (kind !== "postgresql") {
          throw new Error(
            `Cannot create a role on MySQL database "${database}". Roles are only supported on PostgreSQL databases. For MySQL databases, please use the Password resource instead.`,
          );
        }
        const role = await api.organizations.databases.branches.roles.post({
          path: {
            organization,
            database,
            branch,
          },
          body: {
            ttl: props.ttl,
            inherited_roles: props.inherited_roles,
          },
        });
        return this({
          ...props,
          id: role.id,
          name: role.name,
          host: role.access_host_url,
          username: role.username,
          password: alchemy.secret(role.password),
          expiresAt: role.expires_at,
        });
      }
      case "update": {
        // According to the types, the only property that can be updated is the name.
        // However, I was getting 500 errors when trying to update the name, so we'll just replace.
        return this.replace();
      }
    }
  },
);

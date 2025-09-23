import { Secret } from "../secret.ts";
import type { Neon } from "./api.ts";

export interface NeonConnectionUri {
  /**
   * Connection URI string
   */
  connection_uri: Secret;

  /**
   * Connection parameters
   */
  connection_parameters: {
    database: string;
    host: string;
    port: number;
    user: string;
    password: Secret;
  };
}

export function formatConnectionUri(
  details: Neon.ConnectionDetails,
): NeonConnectionUri {
  return {
    connection_uri: new Secret(details.connection_uri),
    connection_parameters: {
      database: details.connection_parameters.database,
      host: details.connection_parameters.host,
      port: 5432,
      user: details.connection_parameters.role,
      password: new Secret(details.connection_parameters.password),
    },
  };
}

export interface NeonRole {
  /**
   * The ID of the branch to which the role belongs
   */
  branch_id: string;
  /**
   * The role name
   */
  name: string;
  /**
   * The role password
   */
  password?: Secret;
  /**
   * Whether or not the role is system-protected
   */
  protected?: boolean;
  /**
   * A timestamp indicating when the role was created
   */
  created_at: string;
  /**
   * A timestamp indicating when the role was last updated
   */
  updated_at: string;
}

export function formatRole(role: Neon.Role): NeonRole {
  return {
    ...role,
    password: role.password ? new Secret(role.password) : undefined,
  };
}

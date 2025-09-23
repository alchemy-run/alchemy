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

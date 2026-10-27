import { Resource } from "alchemy/Resource";

export interface DevCredentialsProps {
  /** The emulator SSM parameter to write the credentials to. */
  parameterName: string;
}

export interface DevCredentials extends Resource<
  "AWS.Local.DevCredentials",
  DevCredentialsProps,
  {
    /**
     * The emulator SSM parameter holding the developer's current temporary
     * credentials as JSON, refreshed while `alchemy dev` runs.
     */
    parameterName: string;
  }
> {}

/**
 * Relays the developer's own AWS credentials into the floci emulator during
 * `alchemy dev`, so a locally emulated Lambda or ECS task can reach a resource
 * in the real cloud (`Alchemy.remote()`).
 *
 * The dev sidecar reads the credentials from the developer's profile, writes
 * them to an SSM parameter on the emulator, and rewrites it while `alchemy
 * dev` runs. The bindings' runtime clients read the parameter over the
 * emulator endpoint the host already reaches. Nothing is created in the real
 * account. Created by `AWSBindings.Bind`; a no-op outside `alchemy dev`.
 */
export const DevCredentials = Resource<DevCredentials>("AWS.Local.DevCredentials");

/** The JSON shape stored in {@link DevCredentials}' parameter. */
export interface DevCredentialsValue {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
  region: string;
  /** Epoch milliseconds. */
  expiration: number | undefined;
}

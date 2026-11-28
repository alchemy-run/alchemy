import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { ConfigError } from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster, ControlPlane as JoinControlPlane, type ControlPlaneProps } from "../Cluster.ts";

export interface GcpControlPlaneProps extends Omit<ControlPlaneProps, "token"> {
  /**
   * The Secret Manager secret holding the control plane's admin token, such
   * as `projects/acme-rivet/secrets/rivet-token`: the `tokenSecret` a
   * `RivetGCP.ComputeEngineControlPlane` stack returns. The deploy reads its
   * latest version as its own identity, which the control plane names in
   * `tokenReaders`.
   */
  tokenSecret: string;
}

/**
 * A Rivet control plane deployed by another stack, joined by its endpoint
 * and the Secret Manager secret that holds its admin token, as a
 * `Rivet.Cluster` Layer. The token is read while deploying, so it never
 * passes through CI variables. Unless `namespace` is set, a
 * `Rivet.Namespace` is created for the stage.
 *
 * ### Joining a control plane from another stack
 * **Example:** Pools in the app's project, the control plane in its own
 * ```typescript
 * export const Cluster = RivetGCP.ControlPlane("Rivet", {
 *   endpoint: "https://rivet-proxy-abc123-uc.a.run.app",
 *   tokenSecret: "projects/acme-rivet/secrets/rivet-token",
 * });
 *
 * export const Default = RivetGCP.CloudRunPool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ControlPlane = (id: string, props: GcpControlPlaneProps) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { tokenSecret, ...rest } = props;
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their token from their own environment.
        return JoinControlPlane(id, { ...rest, token: Redacted.make("") });
      }
      // A token the deploy can't read fails the stack like a missing config
      // value: the deploy's identity isn't in `tokenReaders`, or the name is wrong.
      const env = yield* GcpEnvironment.current.pipe(Effect.orDie);
      const response = yield* secretmanager
        .accessProjectsSecretsVersions({ name: `${tokenSecret}/versions/latest` })
        .pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({ accessToken: env.accessToken, project: env.project }),
          ),
          Effect.mapError(
            (error) =>
              new ConfigError(
                new ConfigProvider.SourceError({
                  message: `Can't read the Rivet admin token from ${tokenSecret} (${error._tag}): ${error.message}`,
                  cause: error,
                }),
              ),
          ),
        );
      const token = yield* Effect.sync(() =>
        Redacted.make(Buffer.from(response.payload?.data ?? "", "base64").toString("utf8")),
      );
      return JoinControlPlane(id, { ...rest, token });
    }),
  ) satisfies Layer.Layer<Cluster, unknown, unknown>;

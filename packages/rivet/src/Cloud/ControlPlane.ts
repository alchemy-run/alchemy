import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";

export interface ControlPlaneProps {
  /**
   * The cluster's endpoint, `https://<cluster>-api.onrivet.dev`. It may
   * carry the namespace and token as userinfo:
   * `https://<namespace>:<token>@<cluster>-api.onrivet.dev`.
   * @default Config.String("RIVET_ENDPOINT")
   */
  endpoint?: string | Config.Config<string>;
  /**
   * The namespace's token.
   * @default the endpoint's userinfo, or Config.Redacted("RIVET_TOKEN")
   */
  token?: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  /**
   * The namespace pools and actors live in, created in the Rivet dashboard.
   * @default the endpoint's userinfo, or Config.String("RIVET_NAMESPACE")
   */
  namespace?: string | Config.Config<string>;
}

/** The Rivet Cloud endpoint is missing its token or namespace. */
export class RivetCloudConfigurationError extends Data.TaggedError(
  "RivetCloud.ConfigurationError",
)<{
  readonly message: string;
}> {}

const resolve = <A>(value: A | Config.Config<A> | undefined, fallback: Config.Config<A>) =>
  value === undefined ? fallback : Config.isConfig(value) ? value : Config.succeed(value);

/**
 * A Rivet Cloud cluster, as a `Rivet.Cluster` Layer. Rivet runs the control
 * plane; your pools of nodes run wherever their pool Layer puts them, and
 * connect out to it — `RivetAWS.EcsPool` creates a VPC of its own for them.
 *
 * Namespaces are created in the Rivet dashboard. Configure the cluster with
 * the endpoint, namespace and token it shows, either as separate values or
 * as one endpoint URL carrying the namespace and token.
 *
 * ### Connecting to Rivet Cloud
 * **Example:** From `RIVET_ENDPOINT`, `RIVET_NAMESPACE` and `RIVET_TOKEN`
 * ```typescript
 * export const Cluster = RivetCloud.ControlPlane();
 * export const Default = RivetAWS.EcsPool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** One endpoint URL with the namespace and token
 * ```typescript
 * export const Cluster = RivetCloud.ControlPlane({
 *   endpoint: Config.String("RIVET_CLOUD_ENDPOINT"),
 * });
 * ```
 *
 * @primitive
 */
export const ControlPlane = (props: ControlPlaneProps = {}) =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their endpoint and token from their own
        // environment at runtime; the cluster is only consulted while deploying.
        return { endpoint: "", token: Redacted.make(""), namespace: "default" };
      }
      const raw = yield* resolve(props.endpoint, Config.String("RIVET_ENDPOINT"));
      const url = yield* Effect.try({
        try: () => new URL(raw),
        catch: () =>
          new RivetCloudConfigurationError({ message: `Invalid Rivet Cloud endpoint: ${raw}` }),
      });
      const userNamespace = decodeURIComponent(url.username);
      const userToken = decodeURIComponent(url.password);
      url.username = "";
      url.password = "";
      const endpoint = url.toString().replace(/\/+$/, "");
      const namespace = userNamespace
        ? userNamespace
        : yield* resolve(props.namespace, Config.String("RIVET_NAMESPACE"));
      const token = userToken
        ? Redacted.make(userToken)
        : yield* resolve(props.token, Config.Redacted("RIVET_TOKEN"));
      if (namespace === "" || Redacted.value(token) === "") {
        return yield* new RivetCloudConfigurationError({
          message: "A Rivet Cloud cluster needs both a namespace and a token.",
        });
      }
      return { endpoint, token, namespace };
    }),
  );

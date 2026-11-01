import * as alb from "@distilled.cloud/stackit/alb";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import {
  LOAD_BALANCER_SERVICE_ID,
  NAME_MAX_LENGTH,
  physicalName,
} from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";

/** The API answered a create or update without a credential reference. */
export class ObservabilityCredentialRefMissing extends Data.TaggedError(
  "Stackit.ALB.ObservabilityCredentialRefMissing",
)<{
  readonly displayName: string;
  readonly message: string;
}> {}

export interface ObservabilityCredentialProps extends ProjectScopedProps {
  /**
   * Display name, up to 253 characters of `[0-9a-z-]`. Updated in place.
   * @default a physical name generated from the app, stage and logical id
   */
  displayName?: string;
  /** Basic-auth username at the logs or metrics endpoint. Updated in place. */
  username: string;
  /**
   * Basic-auth password at the logs or metrics endpoint. Write-only: STACKIT
   * never returns it, so a change is detected against the previous props.
   * Updated in place.
   */
  password: string | Redacted.Redacted<string>;
}

export interface ObservabilityCredentialAttributes {
  /** The reference load balancers name this credential by. */
  credentialsRef: string;
  /** Display name. */
  displayName: string;
  /** Basic-auth username. */
  username: string | undefined;
  /** Project of the credential. */
  projectId: string;
  /** Region of the credential. */
  region: string;
}

export type ObservabilityCredential = Resource<
  "Stackit.ALB.ObservabilityCredential",
  ObservabilityCredentialProps,
  ObservabilityCredentialAttributes,
  never,
  Providers
>;

/**
 * A basic-auth credential a STACKIT Application Load Balancer uses to ship its logs
 * or metrics to a remote-write endpoint, such as a STACKIT Observability
 * instance. Pass `credentialsRef` to the load balancer's `options.observability`.
 *
 * Every field updates in place. Moving it to another project or region replaces
 * it.
 *
 * Ownership: credentials have no labels, so the reference in Alchemy's state is
 * the identity. A name you chose is not an identity, so a credential of that
 * name that Alchemy didn't record is never taken over. `alchemy unsafe nuke` only clears credentials whose `displayName` has
 * the shape of a generated physical name, so choose a name outside that shape
 * for a credential that must survive a nuke.
 *
 * ### Creating a Credential
 * **Example:** A credential from a redacted config value
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("METRICS_PASSWORD");
 * const credential = yield* Stackit.ALB.ObservabilityCredential("Metrics", {
 *   username: "metrics-writer",
 *   password,
 * });
 * ```
 *
 * **Example:** A credential with an explicit display name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("LOGS_PASSWORD");
 * const credential = yield* Stackit.ALB.ObservabilityCredential("Logs", {
 *   displayName: "loki-writer",
 *   username: "loki-writer",
 *   password,
 * });
 * ```
 *
 * ### Using it on a Load Balancer
 * **Example:** Ship metrics with the credential
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("METRICS_PASSWORD");
 * const credential = yield* Stackit.ALB.ObservabilityCredential("Metrics", {
 *   username: "metrics-writer",
 *   password,
 * });
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.ALB.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: {
 *     ephemeralAddress: true,
 *     observability: {
 *       metrics: {
 *         credentialsRef: credential.credentialsRef,
 *         pushUrl: "https://metrics.example.com/api/v1/receive",
 *       },
 *     },
 *   },
 *   listeners: [
 *     {
 *       name: "http",
 *       port: 80,
 *       protocol: "PROTOCOL_HTTP",
 *       http: { hosts: [{ host: "app.example.com", rules: [{ targetPool: "web" }] }] },
 *     },
 *   ],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving the credential to another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * // A new credential is created in the other project, and the old one is
 * // deleted. Load balancers in the old project must stop using it first.
 * const password = yield* Config.redacted("METRICS_PASSWORD");
 * const credential = yield* Stackit.ALB.ObservabilityCredential("Metrics", {
 *   projectId: "22222222-2222-4222-8222-222222222222",
 *   username: "metrics-writer",
 *   password,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Application Load Balancer
 * @category ALB
 */
export const ObservabilityCredential = Resource<ObservabilityCredential>(
  "Stackit.ALB.ObservabilityCredential",
);

const toAttrs = (
  scope: ProjectScope,
  displayName: string,
  credential: alb.CredentialsResponse,
  credentialsRef: string,
): ObservabilityCredentialAttributes => ({
  credentialsRef,
  displayName: credential.displayName ?? displayName,
  username: credential.username,
  ...scope,
});

const getCredential = (scope: ProjectScope, credentialsRef: string) =>
  alb.getCredentials({ ...scope, credentialsRef }).pipe(
    Effect.map((response) => response.credential),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Crash recovery: only a generated name holds the generation, so only it can be claimed. */
const findByGeneratedName = (scope: ProjectScope, id: string) =>
  Effect.gen(function* () {
    const displayName = yield* physicalName(id);
    const { credentials } = yield* alb.listCredentials(scope);
    return (credentials ?? []).find((credential) => credential.displayName === displayName);
  });

const passwordText = (password: string | Redacted.Redacted<string>) =>
  typeof password === "string" ? password : Redacted.value(password);

export const ObservabilityCredentialProvider = () =>
  Provider.succeed(ObservabilityCredential, {
    stables: ["credentialsRef", "projectId", "region"],
    // Nuke ordering: `Stackit.ALB.LoadBalancer` declares a dependency
    // on this type, so load balancers go first and the credential is unused.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { credentials } = yield* alb.listCredentials(scope);
      // No labels to prove ownership: only generated names are cleared.
      return (credentials ?? []).flatMap((credential) =>
        credential.credentialsRef !== undefined &&
        credential.displayName !== undefined &&
        isGeneratedPhysicalName(credential.displayName, NAME_MAX_LENGTH)
          ? [toAttrs(scope, credential.displayName, credential, credential.credentialsRef)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // A new reference is its own identity, so it can't collide with the old one.
      if (hasUnresolvedTrigger<ObservabilityCredentialProps>(news, ["projectId", "region"])) {
        return { action: "replace" } as const;
      }
      const resolved = triggerProps<ObservabilityCredentialProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const credential = yield* getCredential(scope, output.credentialsRef);
        return credential === undefined
          ? undefined
          : toAttrs(scope, output.displayName, credential, output.credentialsRef);
      }
      if (olds?.displayName !== undefined) return undefined;
      const found = yield* findByGeneratedName(scope, id);
      return found?.credentialsRef === undefined
        ? undefined
        : toAttrs(scope, found.displayName ?? "", found, found.credentialsRef);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName = news.displayName ?? output?.displayName ?? (yield* physicalName(id));

      yield* ensureServiceEnabled({ ...scope, serviceId: LOAD_BALANCER_SERVICE_ID });

      // 1. Observe. `output` is a cache for the reference, in its own scope.
      const sameScope = output?.projectId === scope.projectId && output.region === scope.region;
      let credentialsRef = sameScope ? output?.credentialsRef : undefined;
      let credential =
        credentialsRef === undefined ? undefined : yield* getCredential(scope, credentialsRef);
      if (credential === undefined && news.displayName === undefined) {
        credential = yield* findByGeneratedName(scope, id);
      }
      credentialsRef = credential?.credentialsRef;

      // 2. Ensure
      if (credential === undefined || credentialsRef === undefined) {
        const created = yield* alb.createCredentials({
          ...scope,
          displayName,
          username: news.username,
          password: news.password,
        });
        credential = created.credential;
        credentialsRef = credential?.credentialsRef;
      } else if (
        // 3. Sync. The password can't be observed: only the props can show a
        // change. Without previous props (adoption), send it to be sure.
        credential.displayName !== displayName ||
        credential.username !== news.username ||
        olds === undefined ||
        passwordText(olds.password) !== passwordText(news.password)
      ) {
        const updated = yield* alb.updateCredentials({
          ...scope,
          credentialsRef,
          displayName,
          username: news.username,
          password: news.password,
        });
        credential = updated.credential ?? credential;
      }

      if (credential === undefined || credentialsRef === undefined) {
        return yield* new ObservabilityCredentialRefMissing({
          displayName,
          message: `STACKIT returned observability credential ${displayName} without a reference`,
        });
      }

      // 4. Return
      return toAttrs(scope, displayName, credential, credentialsRef);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      // The spec types no 404 on this delete, so read first: gone is done.
      const credential = yield* getCredential(scope, output.credentialsRef);
      if (credential === undefined) return;
      yield* alb.deleteCredentials({ ...scope, credentialsRef: output.credentialsRef });
    }),
  });

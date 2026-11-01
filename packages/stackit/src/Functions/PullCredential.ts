import * as functions from "@distilled.cloud/stackit/functions";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { findOwnedByName, readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  FUNCTIONS_SERVICE_ID,
  getPullCredentialOrUndefined,
  isFunctionsEnabled,
  listAllPullCredentials,
  PULL_CREDENTIAL_NAME_MAX_LENGTH,
} from "./internal.ts";

export interface PullCredentialProps {
  /**
   * Name of the credential, 1-32 characters and unique in the project. Updates
   * in place. If omitted, a unique name is generated from the stack, stage and
   * logical ID.
   */
  name?: string;
  /**
   * Address of the OCI registry, e.g. `ghcr.io` or a
   * `Stackit.ContainerRegistry.Project`'s `registryHost`. Updates in place.
   */
  address: string;
  /** Registry username. Updates in place. */
  username: string;
  /** Registry password or token. Updates in place. */
  password: string | Redacted.Redacted<string>;
  /**
   * User labels. Alchemy's ownership labels are always merged in. Updates in
   * place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the credential. Defaults to the profile's project.
   * Changing it replaces the credential.
   */
  projectId?: string;
}

export interface PullCredentialAttributes {
  /** STACKIT id of the credential. Stable across updates. */
  pullCredentialId: string;
  /** Project that owns the credential. */
  projectId: string;
  /** Region of the Functions API holding the credential. */
  region: string;
  /** Name of the credential. */
  name: string;
  /** Address of the OCI registry. */
  address: string;
  /** Registry username. */
  username: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type PullCredential = Resource<
  "Stackit.Functions.PullCredential",
  PullCredentialProps,
  PullCredentialAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Functions pull credential: the login a `Stackit.Functions.Function`
 * pulls a private image with.
 *
 * Changing `projectId` replaces the credential; everything else updates in place.
 * The first deploy also enables the Functions service
 * (`cloud.stackit.functions`) for the project.
 *
 * The password is never stored in attributes.
 *
 * Ownership is tracked with labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`, `alchemy.instance`). A credential with the same explicit `name`
 * that lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating a Pull Credential
 * **Example:** A token for a private GitHub Container Registry image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const token = yield* Config.Redacted("GHCR_TOKEN");
 * const credential = yield* Stackit.Functions.PullCredential("Ghcr", {
 *   address: "ghcr.io",
 *   username: "my-org",
 *   password: token,
 * });
 * ```
 *
 * **Example:** A pull-only robot of a STACKIT Container Registry project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const puller = yield* Stackit.ContainerRegistry.RobotAccount("Puller", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 *   permissions: [{ resource: "repository", action: "pull" }],
 * });
 * const credential = yield* Stackit.Functions.PullCredential("Registry", {
 *   address: images.registryHost,
 *   username: puller.robotName,
 *   password: puller.secret,
 * });
 * ```
 *
 * ### Using a Pull Credential
 * **Example:** Run a private image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const token = yield* Config.Redacted("GHCR_TOKEN");
 * const credential = yield* Stackit.Functions.PullCredential("Ghcr", {
 *   address: "ghcr.io",
 *   username: "my-org",
 *   password: token,
 * });
 * const api = yield* Stackit.Functions.Function("Api", {
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   pullCredential: credential.pullCredentialId,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Functions
 * @category Functions
 */
export const PullCredential = Resource<PullCredential>("Stackit.Functions.PullCredential");

/** The credential lost its id on the wire; the spec marks it optional. */
export class PullCredentialIdMissing extends Data.TaggedError(
  "Stackit.Functions.PullCredentialIdMissing",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

const passwordText = (password: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(password) ? Redacted.value(password) : password;

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: PULL_CREDENTIAL_NAME_MAX_LENGTH });

const toAttrs = (
  projectId: string,
  region: string,
  pullCredentialId: string,
  credential: functions.PullCredential,
  name: string,
): PullCredentialAttributes => ({
  pullCredentialId,
  projectId,
  region,
  name: credential.name ?? name,
  address: credential.address,
  username: credential.username,
  labels: stripInternalLabels(credential.labels),
});

export const PullCredentialProvider = () =>
  Provider.succeed(PullCredential, {
    stables: ["pullCredentialId", "projectId", "region"],
    // Nuke ordering: `Stackit.Functions.Function` declares a dependency on this
    // type, so functions go first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      if (!(yield* isFunctionsEnabled(env.projectId, env.region))) return [];
      const credentials = yield* listAllPullCredentials(env.projectId);
      return credentials.flatMap((credential) =>
        credential.id !== undefined && isAlchemyOwned(credential.labels)
          ? [toAttrs(env.projectId, env.region, credential.id, credential, credential.name ?? "")]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved project can resolve to the one the credential is already
      // in, and an explicit name can't exist twice there: delete first. A generated
      // name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<PullCredentialProps>(news, ["projectId"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<PullCredentialProps>(news, "name") !== undefined,
        } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if ((news.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace" } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const name = output?.name ?? (yield* toName(id, olds?.name));
      if (output === undefined && !(yield* isFunctionsEnabled(projectId, env.region))) {
        return undefined;
      }
      let credential: functions.PullCredential | undefined =
        output?.pullCredentialId !== undefined
          ? yield* getPullCredentialOrUndefined(projectId, output.pullCredentialId)
          : undefined;
      if (credential === undefined) {
        const credentials = yield* listAllPullCredentials(projectId);
        credential = yield* findOwnedByName(id, name, credentials, {
          instanceId: readGeneration({ instanceId, output, previous }),
        });
        // A foreign credential at the explicit name this resource would create.
        if (credential === undefined && output === undefined && previous === undefined) {
          credential = credentials.find((candidate) => candidate.name === name);
        }
      }
      if (credential?.id === undefined) return undefined;
      const attrs = toAttrs(projectId, env.region, credential.id, credential, name);
      return (yield* hasAlchemyLabels(id, credential.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const name = yield* toName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      yield* ensureServiceEnabled({
        projectId,
        region: env.region,
        serviceId: FUNCTIONS_SERVICE_ID,
      });

      // Observe: `output` is a cache, and its id only counts in this project.
      let credential: functions.PullCredential | undefined =
        output?.projectId === projectId
          ? yield* getPullCredentialOrUndefined(projectId, output.pullCredentialId)
          : undefined;
      // Crash recovery: this generation's labels and name.
      if (credential === undefined) {
        const credentials = yield* listAllPullCredentials(projectId);
        credential = yield* findOwnedByName(id, name, credentials, { instanceId });
      }

      // Ensure
      if (credential === undefined) {
        credential = yield* functions.createPullCredential({
          projectId,
          name,
          address: news.address,
          username: news.username,
          password: news.password,
          labels,
        });
      }
      const pullCredentialId = credential.id;
      if (pullCredentialId === undefined) {
        return yield* new PullCredentialIdMissing({
          resourceName: name,
          message: `STACKIT returned pull credential ${name} without an id`,
        });
      }

      // Sync: only what differs from the observed credential. A response that
      // hides the password reads as a difference and resends it, which is safe.
      const nameDrifted = credential.name !== name;
      const addressDrifted = credential.address !== news.address;
      const usernameDrifted = credential.username !== news.username;
      const passwordDrifted = passwordText(credential.password) !== passwordText(news.password);
      const labelsDrifted = labelsChanged(credential.labels, labels);
      if (nameDrifted || addressDrifted || usernameDrifted || passwordDrifted || labelsDrifted) {
        credential = yield* functions.updatePullCredential({
          projectId,
          pullCredentialId,
          ...(nameDrifted ? { name } : {}),
          ...(addressDrifted ? { address: news.address } : {}),
          ...(usernameDrifted ? { username: news.username } : {}),
          ...(passwordDrifted ? { password: news.password } : {}),
          ...(labelsDrifted ? { labels } : {}),
        });
      }

      return toAttrs(projectId, env.region, pullCredentialId, credential, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* functions
        .deletePullCredential({
          projectId: output.projectId,
          pullCredentialId: output.pullCredentialId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

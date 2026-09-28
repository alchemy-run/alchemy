import * as workers from "@distilled.cloud/cloudflare/workers";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { deploy } from "../../Deploy.ts";
import { destroy } from "../../Destroy.ts";
import * as Interaction from "../../Interaction.ts";
import * as Alchemy from "../../Stack.ts";
import { makeLocalState } from "../../State/LocalState.ts";
import {
  State,
  type StateService,
  type StateStoreError,
} from "../../State/State.ts";
import { UserFacingError } from "../../UserFacingError.ts";
import * as Access from "../Access.ts";
import { Application } from "../Access/Application.ts";
import { ServiceToken } from "../Access/ServiceToken.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import * as Cloudflare from "../Providers.ts";
import { findWorkerId } from "../Workers/WorkerProvider.ts";
import { STATE_STORE_SCRIPT_NAME } from "./Api.ts";
import {
  connectStateStore,
  isTransientBootstrapWriteError,
  makeCloudflareStateStore,
} from "./State.ts";

/**
 * Stack that holds the Cloudflare Access resources protecting the state
 * store. Kept separate from the `CloudflareStateStore` stack so that
 * redeploying or upgrading the store worker (including from an alchemy
 * version that predates protection) never touches them.
 */
export const ACCESS_STACK = "CloudflareStateStoreAccess";

/** Stage of {@link ACCESS_STACK} in the remote state store. */
const ACCESS_STAGE = STATE_STORE_SCRIPT_NAME;

/** Session lifetime for people who log in to the state store. */
export const ACCESS_SESSION_DURATION = "24h";

export class StateStoreAccessError extends Schema.TaggedError<StateStoreAccessError>()(
  "StateStoreAccessError",
  { message: Schema.String },
) {
  readonly [UserFacingError] = true;
}

/** What {@link ACCESS_STACK} persists as its stack output. */
const AccessStackOutput = Schema.Struct({
  applicationId: Schema.String,
  aud: Schema.String,
  tokens: Schema.Array(Schema.String),
});
type AccessStackOutput = typeof AccessStackOutput.Type;

const TOKEN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Validate a state-store token name: lowercase letters, digits, and inner
 * dashes, at most 40 characters. The name becomes part of a logical ID and
 * the Cloudflare service token's display name.
 *
 * @internal exported for unit testing.
 */
export const validateTokenName = (name: string) =>
  TOKEN_NAME.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new StateStoreAccessError({
          message:
            `Invalid token name '${name}'. Use lowercase letters, digits, and dashes ` +
            `(at most 40 characters), e.g. 'github-actions'.`,
        }),
      );

const tokenLogicalId = (name: string) => `Token-${name}`;

/**
 * The fixed policy set of the state store's Access application: members of
 * the Cloudflare account, plus the service tokens created with
 * `alchemy state token create`.
 *
 * @internal exported for unit testing.
 */
export const stateStoreAccessPolicies = <Id>({
  accountId,
  serviceTokenIds,
}: {
  accountId: string;
  serviceTokenIds: ReadonlyArray<Id>;
}) => [
  {
    name: "Cloudflare account members",
    decision: "allow" as const,
    include: [{ cloudflareAccountMember: { accountId } }],
  },
  ...(serviceTokenIds.length === 0
    ? []
    : [
        {
          name: "Alchemy state store tokens",
          decision: "non_identity" as const,
          include: serviceTokenIds.map((tokenId) => ({
            serviceToken: { tokenId },
          })),
        },
      ]),
];

/**
 * Access application covering the state-store worker's production and
 * preview traffic (`workers.dev` and preview URLs).
 *
 * @internal exported for unit testing.
 */
export const stateStoreApplicationProps = <Policies>({
  workerId,
  identityProviderId,
  policies,
}: {
  workerId: string;
  identityProviderId: string;
  policies: Policies;
}) => ({
  type: "self_hosted" as const,
  name: "Alchemy State Store",
  destinations: [
    { type: "worker" as const, workerId },
    { type: "preview_worker" as const, workerId },
  ],
  allowedIdps: [identityProviderId],
  autoRedirectToIdentity: true,
  appLauncherVisible: false,
  sessionDuration: ACCESS_SESSION_DURATION,
  policies,
});

/**
 * Keeps `/version` public. Hostname-and-path applications take precedence
 * over the worker-level application, so this path bypasses Access. Older
 * alchemy versions probe `/version` without Access credentials; without the
 * bypass they would see the store as missing and try to bootstrap a new one.
 *
 * @internal exported for unit testing.
 */
export const versionCheckApplicationProps = (host: string) => ({
  type: "self_hosted" as const,
  name: "Alchemy State Store version check",
  domain: `${host}/version`,
  appLauncherVisible: false,
  policies: [
    {
      name: "Public version check",
      decision: "bypass" as const,
      include: ["everyone" as const],
    },
  ],
});

interface AccessStackConfig {
  readonly accountId: string;
  readonly workerId: string;
  readonly host: string;
  readonly identityProviderId: string;
  readonly tokens: ReadonlyArray<string>;
}

const accessStack = (
  config: AccessStackConfig,
  stateLayer: Layer.Layer<State>,
) =>
  Alchemy.Stack(
    ACCESS_STACK,
    { providers: Cloudflare.providers(), state: stateLayer },
    Effect.gen(function* () {
      const tokens = yield* Effect.forEach(config.tokens, (name) =>
        ServiceToken(tokenLogicalId(name), {
          name: `alchemy-state-store-${name}`,
        }),
      );
      const app = yield* Application(
        "StateStore",
        stateStoreApplicationProps({
          workerId: config.workerId,
          identityProviderId: config.identityProviderId,
          policies: stateStoreAccessPolicies({
            accountId: config.accountId,
            serviceTokenIds: tokens.map((token) => token.serviceTokenId),
          }),
        }),
      );
      yield* Application(
        "VersionCheck",
        versionCheckApplicationProps(config.host),
      );
      return {
        applicationId: app.applicationId,
        aud: app.aud,
        tokens: [...config.tokens],
      };
    }),
  );

const stateLayerOf = (state: StateService) =>
  Layer.succeed(State, Effect.succeed(state));

const deployAccessStack = (
  config: AccessStackConfig,
  state: StateService,
  stage: string,
) => {
  const stateLayer = stateLayerOf(state);
  return deploy({ stage, stack: accessStack(config, stateLayer) }).pipe(
    Effect.provide(stateLayer),
  );
};

const destroyAccessStack = (state: StateService, stage: string) => {
  const stateLayer = stateLayerOf(state);
  return destroy({
    stage,
    stack: Alchemy.Stack(
      ACCESS_STACK,
      { providers: Cloudflare.providers(), state: stateLayer },
      Effect.succeed({}),
    ),
  }).pipe(Effect.provide(stateLayer));
};

const readAccessOutput = (state: StateService, stage: string = ACCESS_STAGE) =>
  state
    .getOutput({ stack: ACCESS_STACK, stage })
    .pipe(
      Effect.map((output) =>
        output === undefined
          ? undefined
          : Schema.decodeUnknownOption(AccessStackOutput)(output).pipe(
              (decoded) =>
                decoded._tag === "Some" ? decoded.value : undefined,
            ),
      ),
    );

const requireProtected = (output: AccessStackOutput | undefined) =>
  output === undefined
    ? Effect.fail(
        new StateStoreAccessError({
          message:
            "The state store is not protected by Cloudflare Access. Run 'alchemy state protect' first.",
        }),
      )
    : Effect.succeed(output);

const ensureZeroTrust = (accountId: string) =>
  zeroTrust.listOrganizationsForAccount({ accountId }).pipe(
    Effect.catchTag("OrganizationNotFound", () =>
      Effect.fail(
        new StateStoreAccessError({
          message:
            "Cloudflare Zero Trust is not set up on this account, and Cloudflare Access requires it. " +
            "Set it up at https://one.dash.cloudflare.com/ (the Free plan is enough), then rerun this command.",
        }),
      ),
    ),
  );

/**
 * Account members sign in with their Cloudflare account, which requires the
 * Cloudflare identity provider. Reuse it when present; otherwise add it. It
 * is left in place on `unprotect` because other Access applications in the
 * account may use it by then.
 */
const ensureCloudflareIdentityProvider = (accountId: string) =>
  Effect.gen(function* () {
    const existing = yield* zeroTrust.listIdentityProvidersForAccount
      .items({ accountId })
      .pipe(
        Stream.filter((idp) => idp.type === "cloudflare" && !!idp.id),
        Stream.runHead,
      );
    if (existing._tag === "Some" && existing.value.id) {
      return existing.value.id;
    }
    yield* Interaction.accessors.output.info(
      "Adding Cloudflare as a Zero Trust login method so account members can sign in with their Cloudflare account.",
    );
    const created = yield* zeroTrust.createIdentityProviderForAccount({
      accountId,
      name: "Cloudflare",
      type: "cloudflare",
      config: {},
    });
    if (!created.id) {
      return yield* new StateStoreAccessError({
        message:
          "Cloudflare did not return an id for the new identity provider.",
      });
    }
    return created.id;
  });

const stateStoreHost = (accountId: string) =>
  workers
    .getSubdomain({ accountId })
    .pipe(
      Effect.map(
        ({ subdomain }) =>
          `${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`,
      ),
    );

const resolveConfig = (tokens: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    yield* ensureZeroTrust(accountId);
    const identityProviderId =
      yield* ensureCloudflareIdentityProvider(accountId);
    const workerId = yield* findWorkerId(accountId, STATE_STORE_SCRIPT_NAME);
    const host = yield* stateStoreHost(accountId);
    return {
      accountId,
      workerId,
      host,
      identityProviderId,
      tokens,
    } satisfies AccessStackConfig;
  });

class AccessNotYetEnforced extends Schema.TaggedError<AccessNotYetEnforced>()(
  "AccessNotYetEnforced",
  { host: Schema.String },
) {}

/** Wait (bounded) until Cloudflare's edge starts enforcing Access on `host`. */
const waitForAccess = (host: string) =>
  Effect.gen(function* () {
    const access = yield* Access.Access;
    if (!(yield* access.usesAccess(host, { refresh: true }))) {
      return yield* new AccessNotYetEnforced({ host });
    }
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "AccessNotYetEnforced",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(45),
      ]),
    }),
    Effect.catchTag("AccessNotYetEnforced", () =>
      Effect.fail(
        new StateStoreAccessError({
          message: `Cloudflare Access did not start protecting ${host} within 90 seconds. Rerun 'alchemy state protect' to finish.`,
        }),
      ),
    ),
  );

/**
 * Copy {@link ACCESS_STACK} (resources and output) between state stores.
 * Writes only; nothing in the destination is deleted.
 */
const copyAccessStack = Effect.fn(function* (
  source: { state: StateService; stage: string },
  destination: { state: StateService; stage: string },
) {
  const retry = <A, R>(write: Effect.Effect<A, StateStoreError, R>) =>
    Effect.retry(write, {
      while: isTransientBootstrapWriteError,
      schedule: Schedule.max([Schedule.fixed(500), Schedule.recurs(60)]),
    });
  const fqns = yield* source.state.list({
    stack: ACCESS_STACK,
    stage: source.stage,
  });
  yield* Effect.forEach(
    fqns,
    (fqn) =>
      Effect.gen(function* () {
        const value = yield* source.state.get({
          stack: ACCESS_STACK,
          stage: source.stage,
          fqn,
        });
        if (value) {
          yield* destination.state
            .set({ stack: ACCESS_STACK, stage: destination.stage, fqn, value })
            .pipe(retry);
        }
      }),
    { concurrency: 4 },
  );
  const output = yield* source.state.getOutput({
    stack: ACCESS_STACK,
    stage: source.stage,
  });
  if (output !== undefined) {
    yield* destination.state
      .setOutput({
        stack: ACCESS_STACK,
        stage: destination.stage,
        value: output,
      })
      .pipe(retry);
  }
});

const localAccessStage = (profile: string) =>
  `${profile}_${STATE_STORE_SCRIPT_NAME}`;

/** A protect run that deployed with local state but never finished copying
 * it into the (now protected) remote store. */
const hasLocalAccessStack = (profile: string) =>
  Effect.gen(function* () {
    const local = yield* makeLocalState();
    const stages = yield* local.listStages(ACCESS_STACK);
    return stages.includes(localAccessStage(profile));
  });

export type ProtectResult =
  | { readonly status: "protected"; readonly host: string }
  | { readonly status: "updated"; readonly host: string };

/**
 * Put the account's state store behind Cloudflare Access with the fixed
 * policy set: members of the Cloudflare account, plus tokens created with
 * `alchemy state token create`.
 *
 * The first run deploys the Access resources with local state (the remote
 * store cannot accept writes from this client once Access enforces), waits
 * for Access to take effect, authenticates, then copies the state into the
 * remote store. An interrupted run resumes from the local copy.
 */
export const protectStateStore = (profile: string) =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    const { credentials, state } = yield* connectStateStore(profile);
    const existing = yield* readAccessOutput(state);
    const resuming = yield* hasLocalAccessStack(profile);

    if (existing !== undefined && !resuming) {
      const config = yield* resolveConfig(existing.tokens);
      yield* interaction.task(
        { label: "Updating Cloudflare Access for the state store" },
        deployAccessStack(config, state, ACCESS_STAGE),
      );
      return { status: "updated", host: config.host } satisfies ProtectResult;
    }

    const local = yield* makeLocalState();
    const localStage = localAccessStage(profile);
    const config = yield* resolveConfig(
      (yield* readAccessOutput(local, localStage))?.tokens ?? [],
    );
    yield* interaction.task(
      { label: "Protecting the state store with Cloudflare Access" },
      deployAccessStack(config, local, localStage),
    );
    yield* interaction.task(
      { label: "Waiting for Cloudflare Access to take effect" },
      waitForAccess(config.host),
    );
    // A fresh client: this one authenticates to Access (service token or
    // `cloudflared` login) now that the store requires it.
    const protectedState = yield* makeCloudflareStateStore(credentials);
    yield* interaction.task(
      { label: "Saving Access configuration to the state store" },
      copyAccessStack(
        { state: local, stage: localStage },
        { state: protectedState, stage: ACCESS_STAGE },
      ),
    );
    yield* local.deleteStack({ stack: ACCESS_STACK, stage: localStage });
    return { status: "protected", host: config.host } satisfies ProtectResult;
  });

/**
 * Remove Cloudflare Access from the state store. Only needs Cloudflare API
 * credentials plus the ability to reach the store, so it doubles as the way
 * back from a broken login setup for anyone who can still authenticate.
 */
export const unprotectStateStore = (profile: string) =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    if (yield* hasLocalAccessStack(profile)) {
      const local = yield* makeLocalState();
      yield* interaction.task(
        { label: "Removing unfinished Cloudflare Access setup" },
        destroyAccessStack(local, localAccessStage(profile)),
      );
    }
    const { state } = yield* connectStateStore(profile);
    if ((yield* readAccessOutput(state)) === undefined) {
      return { status: "not-protected" as const };
    }
    yield* interaction.task(
      { label: "Removing Cloudflare Access from the state store" },
      destroyAccessStack(state, ACCESS_STAGE),
    );
    return { status: "unprotected" as const };
  });

/**
 * Log in to Cloudflare Access for the state store ahead of time. Deploys and
 * other commands log in on demand, so this is optional.
 */
export const loginToStateStore = () =>
  Effect.gen(function* () {
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    const host = yield* stateStoreHost(accountId);
    const access = yield* Access.Access;
    if (!(yield* access.usesAccess(host, { refresh: true }))) {
      return { protected: false as const, host };
    }
    yield* access.getAccessHeaders(host);
    return { protected: true as const, host };
  });

export interface StateStoreToken {
  readonly name: string;
  readonly clientId: string | undefined;
  readonly expiresAt: string | undefined;
}

const readTokenAttrs = (state: StateService, name: string) =>
  state
    .get({
      stack: ACCESS_STACK,
      stage: ACCESS_STAGE,
      fqn: tokenLogicalId(name),
    })
    .pipe(
      Effect.map((resource) =>
        resource !== undefined && "attr" in resource
          ? (resource.attr as {
              clientId?: string;
              clientSecret?: Redacted.Redacted<string>;
              expiresAt?: string;
            })
          : undefined,
      ),
    );

/**
 * Create a service token that can reach the protected state store (for
 * CI/CD). Returns the client secret, which is only shown once.
 */
export const createStateStoreToken = (profile: string, name: string) =>
  Effect.gen(function* () {
    yield* validateTokenName(name);
    const { state } = yield* connectStateStore(profile);
    const output = yield* requireProtected(yield* readAccessOutput(state));
    if (output.tokens.includes(name)) {
      return yield* new StateStoreAccessError({
        message: `A token named '${name}' already exists. Revoke it first with 'alchemy state token revoke ${name}'.`,
      });
    }
    const config = yield* resolveConfig([...output.tokens, name]);
    yield* (yield* Interaction.Interaction).task(
      { label: `Creating state store token '${name}'` },
      deployAccessStack(config, state, ACCESS_STAGE),
    );
    const attrs = yield* readTokenAttrs(state, name);
    if (!attrs?.clientId || !attrs.clientSecret) {
      return yield* new StateStoreAccessError({
        message: `Token '${name}' was created, but its credentials could not be read back from the state store.`,
      });
    }
    return {
      name,
      clientId: attrs.clientId,
      clientSecret: attrs.clientSecret,
      expiresAt: attrs.expiresAt,
    };
  });

/** List the tokens that can reach the protected state store. */
export const listStateStoreTokens = (profile: string) =>
  Effect.gen(function* () {
    const { state } = yield* connectStateStore(profile);
    const output = yield* requireProtected(yield* readAccessOutput(state));
    return yield* Effect.forEach(output.tokens, (name) =>
      readTokenAttrs(state, name).pipe(
        Effect.map((attrs): StateStoreToken => ({
          name,
          clientId: attrs?.clientId,
          expiresAt: attrs?.expiresAt,
        })),
      ),
    );
  });

/** Delete a token and remove it from the state store's Access policy. */
export const revokeStateStoreToken = (profile: string, name: string) =>
  Effect.gen(function* () {
    const { state } = yield* connectStateStore(profile);
    const output = yield* requireProtected(yield* readAccessOutput(state));
    if (!output.tokens.includes(name)) {
      return yield* new StateStoreAccessError({
        message: `No state store token named '${name}'. Run 'alchemy state token list' to see existing tokens.`,
      });
    }
    const config = yield* resolveConfig(
      output.tokens.filter((token) => token !== name),
    );
    yield* (yield* Interaction.Interaction).task(
      { label: `Revoking state store token '${name}'` },
      deployAccessStack(config, state, ACCESS_STAGE),
    );
  });

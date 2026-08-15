import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import { apiKeyCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CloudflareAccess from "../../Cloudflare/Access.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../../Cloudflare/CloudflareEnvironment.ts";
import * as CloudflareCredentials from "../../Cloudflare/Credentials.ts";
import { CloudflareLogs } from "../../Cloudflare/Logs.ts";
import { STATE_STORE_SCRIPT_NAME } from "../../Cloudflare/StateStore/Api.ts";
import {
  bootstrap as bootstrapCloudflare,
  teardownStateStore,
} from "../../Cloudflare/StateStore/State.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  formatLocalTimestamp,
  instrumentCommand,
  parseSince,
  profile,
  yes,
} from "./_shared.ts";
import { resolveProfileName } from "../ProfileSelection.ts";

/**
 * Build the Cloudflare auth + environment layer stack used by every
 * `alchemy provider cloudflare ...` subcommand. Mirrors the wiring inside
 * `Cloudflare.state(...)` so the command can talk to the user's
 * account out-of-band.
 */
const cloudflareLayers = (
  envFileOpt: Option.Option<string>,
  profileName: string,
) =>
  Effect.gen(function* () {
    const authProviders: AuthProviders["Service"] = {};
    const authRegistry = Layer.succeed(AuthProviders, authProviders);
    const authLayer = Layer.provideMerge(CloudflareAuth, authRegistry);
    const cf = Layer.provideMerge(
      Layer.mergeAll(
        CloudflareCredentials.fromAuthProvider(),
        CloudflareEnvironment.fromProfile(),
        CloudflareAccess.AccessLive,
      ),
      authLayer,
    );

    const logger = Logger.layer([fileLogger("cloudflare.txt")], {
      mergeWithExisting: true,
    });

    return Layer.mergeAll(
      cf,
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(envFileOpt), profileName),
      ),
      logger,
    );
  });

const cloudflareForce = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force a full redeploy even if the state-store worker already exists. " +
      "Without this flag, an existing worker is adopted and only its credentials are refreshed.",
  ),
  Flag.withDefault(false),
);

const cloudflareWorkerName = Flag.string("worker-name").pipe(
  Flag.withDescription(
    "Override the default state-store worker name (advanced; only needed for multiple state stores per account).",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile,
    force: cloudflareForce,
    workerName: cloudflareWorkerName,
  },
  instrumentCommand(
    "provider.cloudflare.bootstrap",
    (a: {
      profile: string | undefined;
      force: boolean;
      workerName: string | undefined;
    }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.force": a.force,
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, force, workerName }) {
      const profileName = yield* resolveProfileName(envFile, profile);
      const services = yield* cloudflareLayers(envFile, profileName);
      yield* bootstrapCloudflare({
        workerName,
        force,
        profile: profileName,
      }).pipe(Effect.provide(services));
    }),
  ),
).pipe(
  Command.withDescription(
    "Provision Cloudflare account prerequisites for deployments",
  ),
);

const teardownCommand = Command.make(
  "teardown",
  {
    envFile,
    profile,
    workerName: cloudflareWorkerName,
    yes,
  },
  instrumentCommand(
    "provider.cloudflare.teardown",
    (a: { profile: string | undefined; workerName: string | undefined }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, workerName, yes: approved }) {
      if (
        !approved &&
        !(yield* (yield* CliKit.CliKit).prompt.confirm({
          message:
            "Tear down the Cloudflare state store and its backing resources?",
          initialValue: false,
        }))
      ) {
        return;
      }
      const profileName = yield* resolveProfileName(envFile, profile);
      const services = yield* cloudflareLayers(envFile, profileName);
      yield* teardownStateStore({
        workerName,
        profile: profileName,
      }).pipe(Effect.provide(services));
    }),
  ),
).pipe(
  Command.withDescription("Tear down the Cloudflare state store"),
  Command.unlisted,
);

/**
 * A single resolved Cloudflare token policy in the shape expected by
 * `POST /user/tokens`.
 */
type CreateTokenPolicy = {
  effect: "allow";
  permissionGroups: { id: string }[];
  resources: Record<string, string>;
};

/**
 * Cloudflare scopes that `buildTokenPolicies` knows how to turn into a policy,
 * mapped to a short human label shown as a hint in the selection prompt.
 * Groups with any other scope cannot be expressed as a policy and are omitted
 * from the prompt.
 */
const SELECTABLE_SCOPE_LABELS: Record<string, string> = {
  "com.cloudflare.api.account": "account",
  "com.cloudflare.api.account.zone": "zone",
  "com.cloudflare.api.user": "user",
  "com.cloudflare.edge.r2.bucket": "r2",
};

/**
 * Group permission groups by their Cloudflare scope and produce one policy
 * per scope, wiring up the right resource selector for each:
 *
 * - `com.cloudflare.api.account` → scoped to each selected account ID
 * - `com.cloudflare.api.account.zone` → all zones (`*`)
 * - `com.cloudflare.api.user` → the authenticated user
 * - `com.cloudflare.edge.r2.bucket` → all R2 buckets (`*`)
 * - `com.cloudflare.edge.r2.bucket` → all buckets (`*`)
 *
 * Mirrors the upstream `alchemy` "god token" policy shape. Groups with an
 * unrecognized scope are skipped, and empty policies are dropped. When more
 * than one account is selected, the account-scoped policy lists every chosen
 * account in its `resources` map so the token spans all of them.
 */
const buildTokenPolicies = (
  accountIds: readonly string[],
  userId: string,
  groups: readonly { id: string; scopes: readonly string[] }[],
): CreateTokenPolicy[] => {
  const buckets: Record<string, CreateTokenPolicy> = {
    "com.cloudflare.api.account": {
      effect: "allow",
      permissionGroups: [],
      resources: Object.fromEntries(
        accountIds.map((id) => [`com.cloudflare.api.account.${id}`, "*"]),
      ),
    },
    "com.cloudflare.api.account.zone": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.api.account.zone.*": "*" },
    },
    "com.cloudflare.api.user": {
      effect: "allow",
      permissionGroups: [],
      resources: { [`com.cloudflare.api.user.${userId}`]: "*" },
    },
    "com.cloudflare.edge.r2.bucket": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.edge.r2.bucket.*": "*" },
    },
  };
  const seen = new Set<string>();
  for (const group of groups) {
    const bucket = buckets[group.scopes[0]!];
    if (!bucket || seen.has(group.id)) continue;
    seen.add(group.id);
    bucket.permissionGroups.push({ id: group.id });
  }
  return Object.values(buckets).filter((p) => p.permissionGroups.length > 0);
};

/**
 * Let the user pick which Cloudflare account(s) the token is scoped to. Lists
 * the accounts visible to the configured credentials and prompts a
 * multi-selection (defaulting the cursor to the profile's account). If there's
 * exactly one account, it's used without prompting; if the API returns none,
 * falls back to the profile's account.
 */
const selectAccountIds = (defaultAccountId: string | undefined) =>
  Effect.gen(function* () {
    const list = yield* cfAccounts.listAccounts;
    const response = yield* list({});
    const accounts = response.result;

    if (accounts.length === 0) {
      if (defaultAccountId) return [defaultAccountId];
      return yield* Effect.die(
        "No Cloudflare accounts found for these credentials.",
      );
    }
    if (accounts.length === 1) {
      const account = accounts[0]!;
      yield* (yield* CliKit.CliKit).output.info(
        `Using account: ${account.name} (${account.id})`,
      );
      return [account.id];
    }
    return yield* (yield* CliKit.CliKit).prompt.multiSelect<string>({
      message: "Select the Cloudflare accounts to scope the token to",
      initialValues: defaultAccountId ? [defaultAccountId] : undefined,
      options: accounts.map((a) => ({
        value: a.id,
        label: a.name,
        description:
          a.id === defaultAccountId ? `${a.id} (current profile)` : a.id,
      })),
      required: true,
    });
  });

const allPermissionsFlag = Flag.boolean("all-permissions").pipe(
  Flag.withDescription(
    "Grant the token EVERY Cloudflare permission group (a 'god token'). " +
      "Use with care — it has full access to your account.",
  ),
  Flag.withDefault(false),
);

const tokenNameFlag = Flag.string("name").pipe(
  Flag.withDescription(
    "Name for the API token. Defaults to 'alchemy' (or 'alchemy-all-permissions').",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const tokenAccountIdFlag = Flag.string("account-id").pipe(
  Flag.withDescription(
    "Cloudflare account ID(s) to scope the token to (comma-separated for " +
      "multiple). If omitted, you'll be prompted to select from your accounts.",
  ),
  Flag.optional,
  Flag.map(
    Option.match({
      onNone: () => undefined,
      onSome: (v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    }),
  ),
);

/**
 * `alchemy provider cloudflare create-token` — mint a Cloudflare API token
 * (`POST /user/tokens`).
 *
 * This command is **standalone**: it does not use an Alchemy auth profile.
 * Cloudflare only mints a token whose permissions the authenticating
 * credential is allowed to grant — and OAuth/scoped tokens silently produce a
 * token with zero permissions — so it always authenticates with the account's
 * **Global API Key** (read from `CLOUDFLARE_API_KEY` / `CLOUDFLARE_EMAIL`,
 * otherwise prompted). The key is used only to create the token and is never
 * stored.
 *
 * With `--all-permissions` it builds a "superuser" token spanning every
 * permission group (after a confirmation prompt). Otherwise it prompts the
 * user to pick which permission groups to grant from the account's live set.
 *
 * The token can be scoped to more than one account: pass a comma-separated
 * list to `--account-id`, or (when neither is supplied) pick multiple accounts
 * from the interactive selection prompt.
 */
const createTokenCommand = Command.make(
  "token",
  {
    envFile,
    allPermissions: allPermissionsFlag,
    name: tokenNameFlag,
    accountId: tokenAccountIdFlag,
  },
  instrumentCommand(
    "cloudflare.create-token",
    (a: { allPermissions: boolean }) => ({
      "alchemy.all_permissions": a.allPermissions,
    }),
  )(
    Effect.fn(function* ({ envFile, allPermissions, name, accountId }) {
      const configProvider = ConfigProvider.layer(
        yield* loadConfigProvider(envFile),
      );

      yield* Effect.gen(function* () {
        const prompt = yield* CliKit.CliKit;
        const prepare = Effect.gen(function* () {
          // The Global API Key is a dashboard-only secret — there is no API to
          // fetch it — so read it from the environment or prompt for it. It is
          // used only to create the token and is never stored.
          const envApiKey = yield* Config.string("CLOUDFLARE_API_KEY").pipe(
            Config.option,
            Config.map(Option.getOrUndefined),
          );
          const apiKey =
            envApiKey ??
            (yield* prompt.prompt.password({
              message:
                "Paste your Global API Key (see bottom of https://dash.cloudflare.com/profile/api-tokens)",
              validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
            }));

          const envEmail = yield* Config.string("CLOUDFLARE_EMAIL").pipe(
            Config.option,
            Config.map(Option.getOrUndefined),
          );
          const email =
            envEmail ??
            (yield* prompt.prompt.text({
              message: "Cloudflare account email",
              validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
            }));

          const credentials = Effect.succeed(
            apiKeyCredentials({ apiKey, email }),
          );
          const withCreds = <A, E, R>(self: Effect.Effect<A, E, R>) =>
            self.pipe(
              Effect.provideService(
                CloudflareCredentials.Credentials,
                credentials,
              ),
            );

          const resolvedAccountIds =
            accountId ?? (yield* withCreds(selectAccountIds(undefined)));
          const currentUser = yield* withCreds(user.getUser({}));

          const tokenName =
            name ??
            (yield* prompt.prompt.text({
              message: "Token name",
              placeholder: allPermissions ? "alchemy-superuser" : "alchemy",
              validate: (v) =>
                v.trim().length === 0 ? "Token name is required" : undefined,
            }));

          // Resolve permission groups live from Cloudflare instead of a static
          // catalog. Cloudflare silently ignores permission-group IDs it doesn't
          // recognize, so a stale local list yields a token with zero
          // permissions. `/user/tokens/permission_groups` returns exactly the
          // groups (and IDs) valid for this credential.
          //
          // We hit the endpoint with a raw GET rather than the typed distilled
          // client: the client hard-codes the set of valid `scopes` literals,
          // and Cloudflare keeps adding new ones (e.g. `com.cloudflare.edge.
          // worker.script`), which makes the strict schema reject the whole
          // response. Parsing leniently keeps us forward-compatible.
          const http = yield* HttpClient.HttpClient;
          const headers = {
            "X-Auth-Key": apiKey,
            "X-Auth-Email": email,
            Accept: "application/json",
          };
          const [pgResponse, oauthResponse] = yield* Effect.all(
            [
              http.get(
                "https://api.cloudflare.com/client/v4/user/tokens/permission_groups",
                { headers },
              ),
              http.get("https://api.cloudflare.com/client/v4/oauth/scopes", {
                headers,
              }),
            ],
            { concurrency: "unbounded" },
          );
          const pgBody = (yield* pgResponse.json) as {
            result?: {
              id?: string;
              name?: string;
              category?: string;
              scopes?: string[];
            }[];
          };
          const oauthBody = (yield* oauthResponse.json) as {
            result?: {
              id?: string;
              name?: string;
              category?: string;
              scopes?: string[];
            }[];
          };
          // These are separate Cloudflare catalogs with different identifiers
          // and cardinality. Preserve both independently; the name/scope join
          // below is presentation metadata, never the source of token policy
          // membership.
          const oauthScopes = (oauthBody.result ?? []).flatMap((scope) =>
            scope.id && scope.name && scope.scopes
              ? [
                  {
                    id: scope.id,
                    name: scope.name,
                    category: scope.category,
                    scopes: scope.scopes,
                  },
                ]
              : [],
          );
          const oauthScopeByPermission = new Map(
            oauthScopes.flatMap((scope) =>
              scope.scopes.map(
                (resourceScope) =>
                  [`${scope.name}\0${resourceScope}`, scope] as const,
              ),
            ),
          );
          const permissionGroups = (pgBody.result ?? []).flatMap((group) =>
            group.id && group.name && group.scopes?.length
              ? [
                  {
                    id: group.id,
                    name: group.name,
                    category: group.category,
                    scopes: group.scopes,
                  },
                ]
              : [],
          );

          let selected: typeof permissionGroups;
          if (allPermissions) {
            selected = permissionGroups;
          } else {
            // Only groups whose scope maps to one of the four policy buckets
            // can actually become a policy (see `buildTokenPolicies`); offering
            // the rest would let the user "select" permissions that are then
            // silently dropped. Restrict the prompt to selectable groups.
            const selectable = permissionGroups
              .filter(
                (g) => SELECTABLE_SCOPE_LABELS[g.scopes[0]!] !== undefined,
              )
              .sort(
                (a, b) =>
                  (a.category ?? "").localeCompare(b.category ?? "") ||
                  a.name.localeCompare(b.name) ||
                  a.scopes[0]!.localeCompare(b.scopes[0]!),
              );

            const chosenIds = yield* prompt.prompt.multiSelect<string>({
              message: "Select the permission groups to grant",
              descriptionPlacement: "inline",
              options: selectable.map((group) => {
                const oauthScope = oauthScopeByPermission.get(
                  `${group.name}\0${group.scopes[0]}`,
                );
                return {
                  value: group.id,
                  label:
                    oauthScope === undefined
                      ? group.name
                      : `${group.name} (${oauthScope.id})`,
                  description: SELECTABLE_SCOPE_LABELS[group.scopes[0]!],
                };
              }),
              required: true,
            });

            const chosen = new Set(chosenIds);
            selected = selectable.filter((g) => chosen.has(g.id));
          }
          const policies = buildTokenPolicies(
            resolvedAccountIds,
            currentUser.id,
            selected,
          );

          if (policies.length === 0) {
            return yield* Effect.die(
              "No permission groups resolved for this account; cannot create a token.",
            );
          }

          if (allPermissions) {
            yield* prompt.output.warning(
              "This token will have FULL access to your Cloudflare account. " +
                "Keep it secret — anyone with it can control your account.",
            );
            const ok = yield* prompt.prompt.confirm({
              message: "Create a superuser token with all permissions?",
              initialValue: false,
            });
            if (!ok) {
              return yield* Effect.succeed(undefined);
            }
          }

          return { apiKey, email, http, policies, tokenName };
        });

        const prepared = yield* prompt.terminal.input
          ? prompt.wizard(prepare)
          : prepare;
        if (prepared === undefined) {
          yield* prompt.output.info("Cancelled.");
          return;
        }
        const { apiKey, email, http, policies, tokenName } = prepared;
        const credentials = Effect.succeed(
          apiKeyCredentials({ apiKey, email }),
        );
        const withCreds = <A, E, R>(self: Effect.Effect<A, E, R>) =>
          self.pipe(
            Effect.provideService(
              CloudflareCredentials.Credentials,
              credentials,
            ),
          );

        const result = yield* withCreds(
          user.createToken({ name: tokenName, policies }),
        );

        if (!result.value) {
          return yield* Effect.die(
            "Cloudflare did not return a token value. Try again.",
          );
        }

        // Cloudflare echoes back the policies it actually accepted. It silently
        // drops permission groups the authenticating user isn't allowed to
        // grant — so a token can come back with zero permissions even though
        // the request was well-formed. Count what was granted and warn loudly
        // if it's empty (almost always an account-role problem, not a bug).
        const granted = (result.policies ?? []).reduce(
          (n, p) => n + (p.permissionGroups?.length ?? 0),
          0,
        );

        // Verify the freshly minted token actually authenticates. The
        // Cloudflare dashboard has a long-standing rendering bug where
        // API-created tokens show a blank permission summary (and a disabled
        // "View"), which makes a perfectly good token look empty. A live
        // `/user/tokens/verify` is the source of truth.
        const status = yield* http
          .get("https://api.cloudflare.com/client/v4/user/tokens/verify", {
            headers: {
              Authorization: `Bearer ${result.value}`,
              Accept: "application/json",
            },
          })
          .pipe(
            Effect.flatMap((r) => r.json),
            Effect.map(
              (b) => (b as { result?: { status?: string } }).result?.status,
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );

        yield* Console.log("");
        yield* Console.log(
          `Created Cloudflare API token "${result.name ?? tokenName}" (${result.id ?? "unknown id"}).`,
        );
        yield* Console.log(
          `Granted ${granted} permission group(s) across ${result.policies?.length ?? 0} policy(ies)` +
            (status ? `; token status: ${status}.` : "."),
        );
        yield* Console.log("");
        yield* Console.log(result.value);
        yield* Console.log("");
        yield* Console.log(
          "Store this value now — Cloudflare only shows it once. " +
            "Use it as CLOUDFLARE_API_TOKEN.",
        );

        if (granted === 0) {
          yield* (yield* CliKit.CliKit).output.warning(
            "Cloudflare granted 0 permissions. A token can only carry permissions " +
              "the authenticating user already holds, so this usually means the " +
              "Global API Key's user is not a Super Administrator on the selected " +
              "account. Check the user's role in the Cloudflare dashboard " +
              "(Members) and retry with an owner/Super Administrator.",
          );
        } else {
          // Token is good; preempt the "it looks empty" confusion.
          yield* (yield* CliKit.CliKit).output.info(
            "Heads up: the Cloudflare dashboard often renders API-created tokens " +
              'with a blank permission summary (and a greyed-out "View") — this is ' +
              "a known UI bug, not a broken token. The permissions above are applied. " +
              'To see them in the dashboard, open the token and click "← Edit token".',
          );
        }
      }).pipe(Effect.provide(configProvider));
    }),
  ),
).pipe(Command.withDescription("Create a scoped Cloudflare API token"));

const followFlag = Flag.boolean("follow").pipe(
  Flag.withAlias("f"),
  Flag.withDescription(
    "Stream logs in real time via the Cloudflare tail websocket instead of fetching past entries.",
  ),
  Flag.withDefault(false),
);

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription(
    "Number of log entries to fetch (ignored with --follow)",
  ),
  Flag.withDefault(100),
);

const sinceFlag = Flag.string("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * `alchemy provider cloudflare state logs` — get or follow logs from the
 * `alchemy-state-store` Worker on the user's account. Lets us debug
 * the state-store worker without standing up a stack file.
 */
const stateLogsCommand = Command.make(
  "logs",
  {
    envFile,
    profile,
    workerName: cloudflareWorkerName,
    follow: followFlag,
    limit: limitFlag,
    since: sinceFlag,
  },
  instrumentCommand(
    "cloudflare.state.logs",
    (a: {
      profile: string | undefined;
      workerName: string | undefined;
      follow: boolean;
      limit: number;
    }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.worker_name": a.workerName ?? STATE_STORE_SCRIPT_NAME,
      "alchemy.follow": a.follow,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fn(function* ({
      envFile,
      profile,
      workerName,
      follow,
      limit,
      since,
    }) {
      const profileName = yield* resolveProfileName(envFile, profile);
      const services = yield* cloudflareLayers(envFile, profileName);
      const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;

      yield* Effect.gen(function* () {
        const { accountId } =
          yield* yield* CloudflareEnvironment.CloudflareEnvironment;
        const telemetry = yield* CloudflareLogs;

        const formatLine = (line: { timestamp: Date; message: string }) =>
          `${formatLocalTimestamp(line.timestamp)} [${scriptName}] ${line.message}`;

        if (follow) {
          yield* (yield* CliKit.CliKit).output.info(`Tailing ${scriptName}...`);
          yield* telemetry
            .tailScript({ accountId, scriptName })
            .pipe(Stream.runForEach((line) => Console.log(formatLine(line))));
          return;
        }

        const sinceDate = since ? parseSince(since) : undefined;
        const lines = yield* telemetry.queryLogs({
          accountId,
          filters: [
            {
              key: "$workers.scriptName",
              operation: "eq",
              type: "string",
              value: scriptName,
            },
          ],
          options: { limit, since: sinceDate },
        });

        if (lines.length === 0) {
          yield* Console.log(`(no log entries for ${scriptName})`);
          return;
        }

        for (const line of lines.sort(
          (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
        )) {
          yield* Console.log(formatLine(line));
        }
      }).pipe(Effect.provide(services));
    }),
  ),
).pipe(
  Command.withDescription("Stream or fetch logs from the state-store worker"),
);

const stateCommand = Command.make("state", {}).pipe(
  Command.withDescription("Manage the Cloudflare-hosted state store"),
  Command.withSubcommands([stateLogsCommand]),
);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withDescription("Manage Cloudflare provider prerequisites"),
  Command.withSubcommands([
    bootstrapCommand,
    teardownCommand,
    createTokenCommand,
    stateCommand,
  ]),
);

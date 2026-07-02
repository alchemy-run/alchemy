import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import { apiKeyCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CloudflareAccess from "../../Cloudflare/Access.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import {
  buildTokenPolicies,
  fetchLivePermissionGroups,
  mintToken,
  resolveRequiredGroups,
  SELECTABLE_SCOPE_LABELS,
} from "../../Cloudflare/Auth/CreateToken.ts";
import { collectCloudflareRequirements } from "../../Cloudflare/Auth/Requirements.ts";
import * as CloudflareEnvironment from "../../Cloudflare/CloudflareEnvironment.ts";
import * as CloudflareCredentials from "../../Cloudflare/Credentials.ts";
import { CloudflareLogs } from "../../Cloudflare/Logs.ts";
import { STATE_STORE_SCRIPT_NAME } from "../../Cloudflare/StateStore/Api.ts";
import { bootstrap as bootstrapCloudflare } from "../../Cloudflare/StateStore/State.ts";
import * as Provider from "../../Provider.ts";
import { Stage } from "../../Stage.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  formatLocalTimestamp,
  importStack,
  instrumentCommand,
  parseSince,
  profile,
} from "./_shared.ts";

/**
 * Build the Cloudflare auth + environment layer stack used by every
 * `alchemy cloudflare ...` subcommand. Mirrors the wiring inside
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
    "cloudflare.bootstrap",
    (a: {
      profile: string;
      force: boolean;
      workerName: string | undefined;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.force": a.force,
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, force, workerName }) {
      const services = yield* cloudflareLayers(envFile, profile);
      yield* bootstrapCloudflare({
        workerName,
        force,
        profile,
      }).pipe(Effect.provide(services));
    }),
  ),
);

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
      yield* Clank.info(`Using account: ${account.name} (${account.id})`);
      return [account.id];
    }
    return yield* Clank.multiselect<string>({
      message:
        "Select the Cloudflare account(s) to scope the token to " +
        "(space to toggle, enter to confirm)",
      initialValues: defaultAccountId ? [defaultAccountId] : undefined,
      options: accounts.map((a) => ({
        value: a.id,
        label: a.name,
        hint: a.id === defaultAccountId ? `${a.id} (current profile)` : a.id,
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

const fromStackFlag = Flag.string("from-stack").pipe(
  Flag.withDescription(
    "Derive the permission groups from a stack file's resources (via provider " +
      "metadata) instead of prompting — e.g. --from-stack alchemy.run.ts. " +
      "Mints a least-privilege token covering exactly what the stack manages.",
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
 * `alchemy cloudflare create-token` — mint a Cloudflare API token
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
  "create-token",
  {
    envFile,
    allPermissions: allPermissionsFlag,
    name: tokenNameFlag,
    accountId: tokenAccountIdFlag,
    fromStack: fromStackFlag,
  },
  instrumentCommand(
    "cloudflare.create-token",
    (a: { allPermissions: boolean; fromStack: string | undefined }) => ({
      "alchemy.all_permissions": a.allPermissions,
      "alchemy.from_stack": a.fromStack ?? "",
    }),
  )(
    Effect.fn(function* ({
      envFile,
      allPermissions,
      name,
      accountId,
      fromStack,
    }) {
      const configProvider = ConfigProvider.layer(
        yield* loadConfigProvider(envFile),
      );

      yield* Effect.gen(function* () {
        // --from-stack: compile the stack (no cloud calls — resource
        // constructors only register nodes) and derive the required
        // permission groups from the providers' metadata. Fail fast, before
        // prompting for the Global API Key.
        let requiredGroups:
          | Map<string, { name: string; resourceTypes: string[] }>
          | undefined;
        if (fromStack !== undefined) {
          if (allPermissions) {
            return yield* Effect.die(
              "--from-stack and --all-permissions are mutually exclusive.",
            );
          }
          const stackEffect = yield* importStack(fromStack);
          const compiled = yield* stackEffect.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(AuthProviders, {}),
                Layer.succeed(Stage, "placeholder"),
              ),
            ),
            Effect.result,
          );
          if (Result.isFailure(compiled)) {
            return yield* Effect.die(
              `Could not compile stack "${fromStack}" to derive its permission requirements:\n${compiled.failure}`,
            );
          }
          const stack = compiled.success;
          const metadata = Provider.collectProviderMetadata(
            stack.services,
            Object.values(stack.resources).map((r: { Type: string }) => r.Type),
          );
          const requirements = collectCloudflareRequirements(metadata);
          if (requirements.permissionGroups.size === 0) {
            return yield* Effect.die(
              `Stack "${fromStack}" declares no Cloudflare resources with token requirements; nothing to mint.`,
            );
          }
          requiredGroups = requirements.permissionGroups;
          yield* Clank.info(
            `Derived ${requiredGroups.size} permission group(s) from ${
              metadata.used?.size ?? 0
            } resource type(s) in ${fromStack}.`,
          );
        }
        // The Global API Key is a dashboard-only secret — there is no API to
        // fetch it — so read it from the environment or prompt for it. It is
        // used only to create the token and is never stored.
        const envApiKey = yield* Config.string("CLOUDFLARE_API_KEY").pipe(
          Config.option,
          Config.map(Option.getOrUndefined),
        );
        const apiKey =
          envApiKey ??
          (yield* Clank.password({
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
          (yield* Clank.text({
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

        const tokenName =
          name ??
          (yield* Clank.text({
            message: "Token name",
            placeholder: allPermissions ? "alchemy-superuser" : "alchemy",
            validate: (v) =>
              v.trim().length === 0 ? "Token name is required" : undefined,
          }));

        const liveGroups = yield* fetchLivePermissionGroups({ apiKey, email });

        let selected: typeof liveGroups;
        if (allPermissions) {
          selected = liveGroups;
        } else if (requiredGroups !== undefined) {
          const resolved = resolveRequiredGroups(requiredGroups, liveGroups);
          selected = resolved.selected;
          if (resolved.missing.length > 0) {
            yield* Clank.warn(
              "Some permission groups from the stack's metadata are not available " +
                `to this credential and will be omitted:\n${resolved.missing
                  .map((m) => `  - ${m}`)
                  .join("\n")}`,
            );
          }
        } else {
          // Only groups whose scope maps to one of the three policy buckets
          // can actually become a policy (see `buildTokenPolicies`); offering
          // the rest would let the user "select" permissions that are then
          // silently dropped. Restrict the prompt to selectable groups.
          const selectable = liveGroups
            .filter((g) => SELECTABLE_SCOPE_LABELS[g.scopes[0]!] !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name));

          const chosenIds = yield* Clank.multiselect<string>({
            message:
              "Select the permission groups to grant (space to toggle, enter to confirm)",
            options: selectable.map((g) => ({
              value: g.id,
              label: g.name,
              hint: SELECTABLE_SCOPE_LABELS[g.scopes[0]!],
            })),
            required: true,
          });

          const chosen = new Set(chosenIds);
          selected = selectable.filter((g) => chosen.has(g.id));
        }
        const policies = buildTokenPolicies(resolvedAccountIds, selected);

        if (policies.length === 0) {
          return yield* Effect.die(
            "No permission groups resolved for this account; cannot create a token.",
          );
        }

        if (allPermissions) {
          yield* Clank.warn(
            "This token will have FULL access to your Cloudflare account. " +
              "Keep it secret — anyone with it can control your account.",
          );
          const ok = yield* Clank.confirm({
            message: "Create a superuser token with all permissions?",
            initialValue: false,
          });
          if (!ok) {
            yield* Console.log("Cancelled.");
            return;
          }
        }

        const minted = yield* mintToken({
          auth: { apiKey, email },
          name: tokenName,
          policies,
        });

        if (!minted.value) {
          return yield* Effect.die(
            "Cloudflare did not return a token value. Try again.",
          );
        }
        const granted = minted.granted;

        yield* Console.log("");
        yield* Console.log(
          `Created Cloudflare API token "${minted.name ?? tokenName}" (${minted.id ?? "unknown id"}).`,
        );
        yield* Console.log(
          `Granted ${granted} permission group(s) across ${minted.policiesCount} policy(ies)` +
            (minted.status ? `; token status: ${minted.status}.` : "."),
        );
        yield* Console.log("");
        yield* Console.log(minted.value);
        yield* Console.log("");
        yield* Console.log(
          "Store this value now — Cloudflare only shows it once. " +
            "Use it as CLOUDFLARE_API_TOKEN.",
        );

        if (granted === 0) {
          yield* Clank.warn(
            "Cloudflare granted 0 permissions. A token can only carry permissions " +
              "the authenticating user already holds, so this usually means the " +
              "Global API Key's user is not a Super Administrator on the selected " +
              "account. Check the user's role in the Cloudflare dashboard " +
              "(Members) and retry with an owner/Super Administrator.",
          );
        } else {
          // Token is good; preempt the "it looks empty" confusion.
          yield* Clank.info(
            "Heads up: the Cloudflare dashboard often renders API-created tokens " +
              'with a blank permission summary (and a greyed-out "View") — this is ' +
              "a known UI bug, not a broken token. The permissions above are applied. " +
              'To see them in the dashboard, open the token and click "← Edit token".',
          );
        }
      }).pipe(Effect.provide(configProvider));
    }),
  ),
);

const tailFlag = Flag.boolean("tail").pipe(
  Flag.withDescription(
    "Stream logs in real time via the Cloudflare tail websocket instead of fetching past entries.",
  ),
  Flag.withDefault(false),
);

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch (ignored with --tail)"),
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
 * `alchemy cloudflare state logs` — get or tail logs from the
 * `alchemy-state-store` Worker on the user's account. Lets us debug
 * the state-store worker without standing up a stack file.
 */
const stateLogsCommand = Command.make(
  "logs",
  {
    envFile,
    profile,
    workerName: cloudflareWorkerName,
    tail: tailFlag,
    limit: limitFlag,
    since: sinceFlag,
  },
  instrumentCommand(
    "cloudflare.state.logs",
    (a: {
      profile: string;
      workerName: string | undefined;
      tail: boolean;
      limit: number;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.worker_name": a.workerName ?? STATE_STORE_SCRIPT_NAME,
      "alchemy.tail": a.tail,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fn(function* ({ envFile, profile, workerName, tail, limit, since }) {
      const services = yield* cloudflareLayers(envFile, profile);
      const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;

      yield* Effect.gen(function* () {
        const { accountId } =
          yield* yield* CloudflareEnvironment.CloudflareEnvironment;
        const telemetry = yield* CloudflareLogs;

        const formatLine = (line: { timestamp: Date; message: string }) =>
          `${formatLocalTimestamp(line.timestamp)} [${scriptName}] ${line.message}`;

        if (tail) {
          yield* Console.log(`Tailing ${scriptName}...`);
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
);

const stateCommand = Command.make("state", {}).pipe(
  Command.withSubcommands([stateLogsCommand]),
);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withSubcommands([bootstrapCommand, createTokenCommand, stateCommand]),
);

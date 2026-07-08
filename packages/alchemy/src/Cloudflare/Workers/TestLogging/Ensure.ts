import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { sha256 } from "../../../Util/sha256.ts";
import {
  TEST_LOGGER_BINDING,
  TEST_LOGGER_CLASS_NAME,
  TEST_LOGGER_DO_NAME_ENV,
  TEST_LOGGER_SCRIPT_NAME,
  TEST_LOGGER_WORKER_NAME_ENV,
} from "./constants.ts";
import {
  LOGGER_WORKER_MAIN_MODULE,
  loggerWorkerScript,
} from "./LoggerWorker.ts";
import { registerTestLoggerTarget, type TestLoggerTarget } from "./Registry.ts";

const VERSION_TAG_PREFIX = "alchemy:test-logger:";

// The singleton is shared by every worker of every stack in the process —
// serialize concurrent ensures (a stack's workers reconcile in parallel) and
// memoize per account so a deploy pays the check exactly once.
const ensureLock = Semaphore.makeUnsafe(1);
const ensuredByAccount = new Map<string, TestLoggerTarget>();

const transientRetry = () => ({
  while: (e: { _tag: string }) =>
    e._tag === "WorkerNotFound" ||
    e._tag === "InternalServerError" ||
    e._tag === "UnknownCloudflareError",
  schedule: Schedule.exponential(200).pipe(Schedule.both(Schedule.recurs(10))),
});

const uploadLoggerWorker = Effect.fn(function* (
  accountId: string,
  versionTag: string,
  existing: workers.GetScriptScriptAndVersionSettingResponse | undefined,
) {
  const hasClass = (existing?.bindings ?? []).some(
    (binding) =>
      binding.type === "durable_object_namespace" &&
      "className" in binding &&
      binding.className === TEST_LOGGER_CLASS_NAME,
  );
  yield* workers
    .putScript({
      accountId,
      scriptName: TEST_LOGGER_SCRIPT_NAME,
      metadata: {
        mainModule: LOGGER_WORKER_MAIN_MODULE,
        compatibilityDate: "2026-03-17",
        bindings: [
          {
            type: "durable_object_namespace",
            name: "LOGGER",
            className: TEST_LOGGER_CLASS_NAME,
          },
        ],
        migrations: hasClass
          ? undefined
          : {
              oldTag: undefined,
              newTag: undefined,
              newClasses: [],
              deletedClasses: [],
              renamedClasses: [],
              transferredClasses: [],
              newSqliteClasses: [TEST_LOGGER_CLASS_NAME],
            },
        // The logger must not tail itself into Workers Logs noise.
        observability: { enabled: false },
        tags: [versionTag],
      },
      files: [
        new File([loggerWorkerScript], LOGGER_WORKER_MAIN_MODULE, {
          type: "application/javascript+module",
        }),
      ],
    })
    .pipe(Effect.retry(transientRetry()));
  yield* workers
    .createScriptSubdomain({
      accountId,
      scriptName: TEST_LOGGER_SCRIPT_NAME,
      enabled: true,
      previewsEnabled: true,
    })
    .pipe(Effect.retry(transientRetry()));
});

/**
 * Make sure the account-level `alchemy-test-logger` singleton worker exists
 * at the current version (content hash of its script) with its workers.dev
 * URL enabled, then record the connection target for `doName` in the
 * in-process {@link Registry} so the test harness can subscribe.
 *
 * Idempotent and cheap on the happy path: one settings read when the
 * version tag already matches. Never destroyed — the singleton is shared by
 * every test run on the account.
 */
export const ensureTestLogger = Effect.fn(function* (opts: {
  accountId: string;
  doName: string;
}) {
  const cached = ensuredByAccount.get(opts.accountId);
  if (cached) {
    const target = { ...cached, doName: opts.doName };
    registerTestLoggerTarget(target);
    return target;
  }
  return yield* ensureLock.withPermits(1)(
    Effect.gen(function* () {
      // Re-check under the lock — a concurrent ensure may have completed.
      const won = ensuredByAccount.get(opts.accountId);
      if (won) {
        const target = { ...won, doName: opts.doName };
        registerTestLoggerTarget(target);
        return target;
      }
      const versionTag = `${VERSION_TAG_PREFIX}${(yield* sha256(loggerWorkerScript)).slice(0, 12)}`;
      const existing = yield* workers
        .getScriptScriptAndVersionSetting({
          accountId: opts.accountId,
          scriptName: TEST_LOGGER_SCRIPT_NAME,
        })
        .pipe(
          Effect.map(
            (settings) =>
              settings as
                | workers.GetScriptScriptAndVersionSettingResponse
                | undefined,
          ),
          Effect.catchTag(["WorkerNotFound", "WorkerHasNoVersions"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (!existing?.tags?.includes(versionTag)) {
        yield* Effect.logInfo(
          `Cloudflare test logging: deploying ${TEST_LOGGER_SCRIPT_NAME} (${versionTag})`,
        );
        yield* uploadLoggerWorker(opts.accountId, versionTag, existing);
      } else {
        // Version matches; still converge the subdomain in case it was
        // disabled out-of-band.
        const subdomain = yield* workers
          .getScriptSubdomain({
            accountId: opts.accountId,
            scriptName: TEST_LOGGER_SCRIPT_NAME,
          })
          .pipe(
            Effect.orElseSucceed<workers.GetScriptSubdomainResponse>(() => ({
              enabled: false,
              previewsEnabled: false,
            })),
          );
        if (!subdomain.enabled) {
          yield* workers
            .createScriptSubdomain({
              accountId: opts.accountId,
              scriptName: TEST_LOGGER_SCRIPT_NAME,
              enabled: true,
              previewsEnabled: true,
            })
            .pipe(Effect.retry(transientRetry()));
        }
      }
      const { subdomain } = yield* workers.getSubdomain({
        accountId: opts.accountId,
      });
      const target: TestLoggerTarget = {
        loggerUrl: `https://${TEST_LOGGER_SCRIPT_NAME}.${subdomain}.workers.dev`,
        doName: opts.doName,
        accountId: opts.accountId,
      };
      ensuredByAccount.set(opts.accountId, target);
      registerTestLoggerTarget(target);
      return target;
    }),
  );
});

/**
 * The bindings injected into a user worker so its runtime patch can reach
 * the logger DO: the cross-script namespace binding plus the worker/DO
 * identity env vars the patch stamps onto every log row.
 */
export const testLoggerBindings = (workerName: string, doName: string) =>
  [
    {
      type: "durable_object_namespace" as const,
      name: TEST_LOGGER_BINDING,
      className: TEST_LOGGER_CLASS_NAME,
      scriptName: TEST_LOGGER_SCRIPT_NAME,
    },
    {
      type: "plain_text" as const,
      name: TEST_LOGGER_WORKER_NAME_ENV,
      text: workerName,
    },
    {
      type: "plain_text" as const,
      name: TEST_LOGGER_DO_NAME_ENV,
      text: doName,
    },
  ] satisfies workers.PutScriptRequest["metadata"]["bindings"];

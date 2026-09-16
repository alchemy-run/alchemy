import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

class Marker extends Context.Service<Marker, { value: string }>()(
  "alarm-callback/types/Marker",
) {}
class TransactionFailure extends Data.TaggedError("TransactionFailure")<{
  value: string;
}> {}

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type SuccessOf<T> =
  T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;
type ErrorOf<T> =
  T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never;
type RequirementsOf<T> =
  T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const registration = Cloudflare.makeAlarmCallback(
  "archive",
  Effect.fn(function* (payload: { value: string }) {
    yield* Effect.succeed(payload.value.toUpperCase());
  }),
  { retry: { delay: Duration.seconds(1) } },
);

type Handle = SuccessOf<typeof registration>;
type Options = Parameters<Handle["schedule"]>[1];
type _InfersPayload = Assert<Equal<Options["payload"], { value: string }>>;
type _RequiresStringId = Assert<
  Equal<Parameters<Handle["schedule"]>[0], string>
>;
type _ScheduleIsRuntimeOnly = Assert<
  RuntimeContext extends RequirementsOf<ReturnType<Handle["schedule"]>>
    ? true
    : false
>;
type _CancelIsRuntimeOnly = Assert<
  RuntimeContext extends RequirementsOf<ReturnType<Handle["cancel"]>>
    ? true
    : false
>;

export const schedulingTypes = Effect.gen(function* () {
  const onArchive = yield* registration;
  yield* onArchive.schedule("relative-string", {
    after: "1 second",
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("relative-duration", {
    after: Duration.seconds(1),
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("relative-millis", {
    after: 1_000,
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("absolute-date", {
    at: new Date(1_000),
    payload: { value: "archive" },
  });
  yield* onArchive.schedule("absolute-millis", {
    at: 1_000,
    payload: { value: "archive" },
  });
  yield* onArchive.cancel("archive");

  const wrongPayload = { at: 1_000, payload: { value: 123 } };
  // @ts-expect-error The handler's payload type determines the schedule payload.
  onArchive.schedule("wrong-payload", wrongPayload);
  const missingPayload = { at: 1_000 };
  // @ts-expect-error Scheduling requires the handler payload.
  onArchive.schedule("missing-payload", missingPayload);
  const noTime = { payload: { value: "archive" } };
  // @ts-expect-error Scheduling requires either after or at.
  onArchive.schedule("missing-time", noTime);
  const bothTimes = { after: 1_000, at: 1_000, payload: { value: "archive" } };
  // @ts-expect-error Relative and absolute scheduling are mutually exclusive.
  onArchive.schedule("both-times", bothTimes);
  const invalidDate = { at: "tomorrow", payload: { value: "archive" } };
  // @ts-expect-error Absolute scheduling accepts only Date or epoch milliseconds.
  onArchive.schedule("invalid-date", invalidDate);
  // @ts-expect-error The logical ID is the first positional argument.
  onArchive.schedule({
    id: "inline",
    at: 1_000,
    payload: { value: "archive" },
  });
  // @ts-expect-error Cancellation requires a string ID.
  onArchive.cancel(123);
});

const directTransaction = (storage: Cloudflare.DurableObjectStorage) =>
  storage.transaction(
    Effect.gen(function* () {
      const marker = yield* Marker;
      yield* storage.put("value", marker.value);
      return yield* Effect.fail(
        new TransactionFailure({ value: marker.value }),
      );
    }),
  );

const callbackTransaction = (storage: Cloudflare.DurableObjectStorage) =>
  storage.transaction(
    Effect.fn(function* (transaction: Cloudflare.DurableObjectTransaction) {
      const marker = yield* Marker;
      yield* transaction.put("value", marker.value);
      return yield* Effect.fail(
        new TransactionFailure({ value: marker.value }),
      );
    }),
  );

type _DirectPreservesError = Assert<
  Equal<
    ErrorOf<ReturnType<typeof directTransaction>>,
    TransactionFailure | Cloudflare.DurableObjectStorageError
  >
>;
type _CallbackPreservesError = Assert<
  Equal<
    ErrorOf<ReturnType<typeof callbackTransaction>>,
    TransactionFailure | Cloudflare.DurableObjectStorageError
  >
>;
type _DirectPreservesContext = Assert<
  Equal<
    RequirementsOf<ReturnType<typeof directTransaction>>,
    Marker | RuntimeContext
  >
>;
type _CallbackPreservesContext = Assert<
  Equal<
    RequirementsOf<ReturnType<typeof callbackTransaction>>,
    Marker | RuntimeContext
  >
>;

import { makeD1MigrationExecutor } from "@alchemy.run/cloudflare/D1/ApplyMigrations";
import { describe, expect, it } from "@alchemy.run/test";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { GatewayTimeout, ServiceUnavailable, TooManyRequests } from "@distilled.cloud/core/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

// D1 can run a batch and still fail its reply. Resending it runs the
// migration's DDL twice (#1889), so the batch must not retry transient errors.
describe("makeD1MigrationExecutor", () => {
  it.effect("query keeps the default retry policy; batch does not retry", () =>
    Effect.gen(function* () {
      const policies: Array<Option.Option<Retry.Policy>> = [];
      const executor = makeD1MigrationExecutor(() =>
        Effect.serviceOption(Retry.Retry).pipe(
          Effect.map((policy) => {
            policies.push(policy);
            return { result: [{ results: [] }] };
          }),
        ),
      );

      yield* executor.batch(["CREATE TABLE t (id INTEGER)"]);
      yield* executor.query("SELECT 1");

      const [batch, query] = policies;
      expect(query?._tag).toBe("None");
      expect(batch?._tag).toBe("Some");
      const policy = Option.getOrThrow(batch!);
      const options =
        typeof policy === "function" ? policy(yield* Ref.make<unknown>(undefined)) : policy;
      for (const error of [
        new ServiceUnavailable({ message: "lost reply" }),
        new GatewayTimeout({ message: "lost reply" }),
        new TooManyRequests({ message: "rate limited" }),
      ]) {
        expect(options.while?.(error)).toBe(false);
      }
    }),
  );
});

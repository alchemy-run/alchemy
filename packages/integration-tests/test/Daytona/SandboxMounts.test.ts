import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/daytona/Credentials";
import * as toolboxProcess from "@distilled.cloud/daytona/process";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as snapshots from "@distilled.cloud/daytona/snapshots";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Tooled, { NeedsNfs } from "./fixtures/program/tooled.ts";

const { test } = Test.make({ providers: Daytona.providers() });

const tags = ["provider:daytona", "provider:daytona:sandbox", "live"];

/** Run a command in a sandbox with the deployer's credentials. */
const execIn = (sandboxId: string, command: string) =>
  Effect.gen(function* () {
    const base = yield* Credentials;
    return yield* toolboxProcess.executeCommand({ command }).pipe(
      Effect.provideService(
        Credentials,
        Effect.map(base, (c) => ({ ...c, sandboxId })),
      ),
    );
  });

const snapshotState = (name: string) =>
  snapshots.getSnapshot({ id: name }).pipe(
    Effect.map((s) => s.state),
    Effect.catchTag("SnapshotNotFound", () => Effect.succeed("gone" as const)),
  );

test.provider.skipIf(!!process.env.FAST)(
  "a binding's mount capability builds a derived snapshot the program sandbox boots from",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          return { tooled: yield* Tooled };
        }),
      );
      const derived = out.tooled.derivedSnapshot!;
      expect(derived).toMatch(/-[0-9a-f]{12}$/);
      const box = yield* sandboxes.getSandbox({ sandboxIdOrName: out.tooled.sandboxId });
      expect(box.snapshot).toEqual(derived);

      // The capability's client is installed, and the program still runs.
      const version = yield* execIn(out.tooled.sandboxId, "jq --version");
      expect(version.result).toMatch(/^jq-/);
      const served = yield* HttpClient.get(out.tooled.url!).pipe(
        Effect.flatMap((r) => (r.status === 200 ? r.text : Effect.fail(new Error(`${r.status}`)))),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
      );
      expect(served).toEqual("tooled");

      // Redeploying unchanged reuses the derived snapshot and the sandbox.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return { tooled: yield* Tooled };
        }),
      );
      expect(again.tooled.sandboxId).toEqual(out.tooled.sandboxId);
      expect(again.tooled.derivedSnapshot).toEqual(derived);

      // The derived snapshot belongs to the sandbox: destroying it deletes both.
      yield* stack.destroy();
      expect(
        yield* snapshotState(derived).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (s) => s === "gone",
            times: 30,
          }),
        ),
      ).toEqual("gone");
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  "a capability a sandbox can't provide fails with MountUnsupported",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return { box: yield* NeedsNfs };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("MountUnsupported");
      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);

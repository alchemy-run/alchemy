import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as volumes from "@distilled.cloud/daytona/volumes";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Agent from "./fixtures/program/agent.ts";

const { test } = Test.make({ providers: Daytona.providers() });

const tags = ["provider:daytona", "provider:daytona:sandbox", "live"];

/** GET a path of the program, retrying while the preview proxy warms up. */
const get = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

const sandboxState = (id: string) =>
  sandboxes.getSandbox({ sandboxIdOrName: id }).pipe(
    Effect.map((s) => s.state),
    Effect.catchTag("SandboxNotFound", () => Effect.succeed("gone" as const)),
  );

test.provider.skipIf(!!process.env.FAST)(
  "a sandbox that runs an Effect program: deploy, a mounted volume, heal after a restart, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        return { agent: yield* Agent };
      });

      const first = yield* stack.deploy(program);
      const id = first.agent.sandboxId;
      expect(first.agent.url).toContain(id);
      expect(first.agent.program?.port).toEqual(3000);

      const served = (yield* get(first.agent.url!)) as { greeting: string; node: string };
      expect(served.greeting).toEqual("hello-from-daytona");
      expect(served.node).toMatch(/^v\d+/);

      // The volume MountVolume bound is mounted into the program's sandbox.
      expect(yield* get(`${first.agent.url}/data`)).toEqual({
        path: "/data",
        files: ["marker.txt"],
      });
      const observed = yield* sandboxes.getSandbox({ sandboxIdOrName: id });
      expect(observed.volumes?.map((v) => v.mountPath)).toEqual(["/data"]);
      // Its auto-stop is off, so the program keeps serving.
      expect(observed.autoStopInterval).toEqual(0);

      // Redeploying unchanged leaves the sandbox and the running process alone.
      const again = yield* stack.deploy(program);
      expect(again.agent.sandboxId).toEqual(id);
      expect(again.agent.program?.commandId).toEqual(first.agent.program?.commandId);

      // Stopping the sandbox ends the process; the next deploy starts both.
      yield* sandboxes.stopSandbox({ sandboxIdOrName: id });
      yield* sandboxState(id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (state) => state === "stopped",
          times: 30,
        }),
      );
      const healed = yield* stack.deploy(program);
      expect(healed.agent.sandboxId).toEqual(id);
      expect(healed.agent.url).toEqual(first.agent.url);
      expect(healed.agent.program?.commandId).not.toEqual(first.agent.program?.commandId);
      expect(((yield* get(healed.agent.url!)) as { greeting: string }).greeting).toEqual(
        "hello-from-daytona",
      );

      const volumeId = observed.volumes![0]!.volumeId;
      yield* stack.destroy();
      expect(
        yield* sandboxState(id).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (state) => state === "gone" || state === "destroyed",
            times: 30,
          }),
        ),
      ).toMatch(/gone|destroyed/);
      const volume = yield* volumes.getVolume({ volumeId }).pipe(
        Effect.map((v) => v.state),
        Effect.catchTag("VolumeNotFound", () => Effect.succeed("gone" as const)),
      );
      expect(["gone", "deleted", "pending_delete", "deleting"]).toContain(volume);
    }),
  { tags, timeout: 600_000 },
);

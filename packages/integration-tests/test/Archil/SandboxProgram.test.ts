import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Objects from "@distilled.cloud/archil/Objects";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import EffectApi from "./fixtures/program/effect.ts";
import { asyncHello, ProgramData, ProgramMount } from "./fixtures/program/resources.ts";

const { test } = Test.make({ providers: Archil.providers() });

const getText = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) => r.text),
      // A fresh hostname or a waking sandbox can take a few seconds.
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
    );
  });

const gone = (sid: string) =>
  archil.getSandbox({ sid }).pipe(
    Effect.map(({ data }) => data.status === "deleted"),
    Effect.catchTag("SandboxNotFound", () => Effect.succeed(true)),
  );

const putText = (diskId: string, key: string, text: string) =>
  Objects.putObject({ disk: diskId }, key, text).pipe(
    Effect.provide(Objects.ObjectCredentialsFromApiKey),
  );

test.provider(
  "program sandboxes run Effect and async programs, mount bound disks, and restart in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (greeting: string) =>
        Effect.gen(function* () {
          const data = yield* ProgramData;
          const mount = yield* ProgramMount;
          const api = yield* EffectApi;
          const hello = yield* asyncHello(greeting);
          return { data, mount, api, hello };
        });

      const { data, mount, api, hello } = yield* stack.deploy(app("hello"));
      expect(api.url).toMatch(/^https:\/\/3000-/);
      expect(api.port).toBe(3000);
      expect(api.code?.hash).toBeTypeOf("string");
      expect(hello.url).toMatch(/^https:\/\/3001-/);

      // MountDisk inside the program added a native mount to its own sandbox.
      const live = yield* archil.getSandbox({ sid: api.sandboxId });
      expect(
        (live.data.mounts ?? []).map((m) => ({ disk: m.disk_id, path: m.path, ro: m.read_only })),
      ).toEqual([{ disk: mount.diskId, path: "/data", ro: true }]);

      // Effect form: one disk read as objects, the other through the mount.
      yield* putText(data.diskId, "note.txt", "from the disk");
      yield* putText(mount.diskId, "mounted.txt", "through the mount");
      expect(yield* getText(`${api.url}/`)).toBe("effect ok");
      expect(yield* getText(`${api.url}/read?key=note.txt`)).toBe("from the disk");
      expect(yield* getText(`${api.url}/mounted?key=mounted.txt`)).toBe("through the mount");

      // Async form: the handler gets env as plain strings.
      expect(JSON.parse(yield* getText(`${hello.url}/x`))).toEqual({
        greeting: "hello",
        path: "/x",
      });

      // A new env restarts the program in its own sandbox; nothing is replaced.
      const updated = yield* stack.deploy(app("bonjour"));
      expect(updated.hello.sandboxId).toBe(hello.sandboxId);
      expect(updated.api.sandboxId).toBe(api.sandboxId);
      expect(JSON.parse(yield* getText(`${updated.hello.url}/y`))).toEqual({
        greeting: "bonjour",
        path: "/y",
      });

      // Removing a program sandbox deletes it; the other keeps serving.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* ProgramData;
          yield* ProgramMount;
          return yield* EffectApi;
        }),
      );
      expect(yield* gone(hello.sandboxId)).toBe(true);
      expect(yield* getText(`${api.url}/`)).toBe("effect ok");

      yield* stack.destroy();
      expect(yield* gone(api.sandboxId)).toBe(true);
    }),
  { tags: ["provider:archil", "provider:archil:sandbox", "live"], timeout: 600_000 },
);

import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "node:path";
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "local Stream direct upload creates, consumes once, and retains video bytes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(
        Cloudflare.Worker("stream-direct-local", {
          main: Path.resolve(
            import.meta.dirname,
            "fixtures/direct-upload-worker.ts",
          ),
          env: { STREAM: Cloudflare.Stream.Stream("STREAM") },
        }),
      );
      yield* Effect.promise(async () => {
        const create = async () => {
          const response = await fetch(`${worker.url}/create`, {
            method: "POST",
            body: JSON.stringify({
              maxDurationSeconds: 60,
              creator: "fixture",
              meta: { name: "direct" },
              allowedOrigins: ["example.com"],
            }),
          });
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<{ id: string; uploadURL: string }>;
        };
        const upload = (url: string) => {
          const form = new FormData();
          form.set(
            "file",
            new Blob(["fixture-video-bytes"], { type: "video/mp4" }),
            "video.mp4",
          );
          return fetch(url, { method: "POST", body: form });
        };
        const created = await create();
        const pending = (await (
          await fetch(`${worker.url}?id=${created.id}`)
        ).json()) as any;
        expect(pending.readyToStream).toBe(false);
        expect(pending.creator).toBe("fixture");
        expect(pending.maxDurationSeconds).toBe(60);
        expect(
          (
            await fetch(created.uploadURL, {
              method: "POST",
              body: new FormData(),
            })
          ).status,
        ).toBe(400);
        const simultaneous = await Promise.all([
          upload(created.uploadURL),
          upload(created.uploadURL),
        ]);
        expect(simultaneous.map((r) => r.status).sort()).toEqual([200, 400]);
        expect((await upload(created.uploadURL)).status).toBe(400);
        const ready = (await (
          await fetch(`${worker.url}?id=${created.id}`)
        ).json()) as any;
        expect(ready.readyToStream).toBe(true);
        expect(ready.meta).toEqual({ name: "direct" });
        expect(await (await fetch(ready.preview)).text()).toBe(
          "fixture-video-bytes",
        );
        const deleted = await create();
        expect(
          (await fetch(`${worker.url}?id=${deleted.id}`, { method: "DELETE" }))
            .status,
        ).toBe(204);
        expect((await upload(deleted.uploadURL)).status).toBe(400);
        await fetch(`${worker.url}?id=${created.id}`, { method: "DELETE" });
      });
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

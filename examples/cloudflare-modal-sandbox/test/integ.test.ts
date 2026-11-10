import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Modal.providers()),
  state: Alchemy.localState(),
});

// The deploy builds the Node and Warm images; a cold Modal build takes minutes.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// The binding prefixes the volume's name with this stack and stage's owner
// digest, so a constant user is already unique per stage. Deriving it from the
// stage pushed `home-<user>` past Modal's 64-character name limit in worktrees.
const user = "tester";

const run = (url: string, command: string) =>
  Test.executeWhenReady(
    HttpClientRequest.post(`${url}/users/${user}/run`).pipe(HttpClientRequest.bodyText(command)),
  ).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as { exitCode: number; output: string }),
  );

test(
  "starts each sandbox from the Warm image, with the user's files mounted",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const repo = yield* run(url, "node -p \"require('./package.json').name\" && pnpm --version");
    expect(repo.exitCode).toBe(0);
    expect(repo.output).toContain("@sindresorhus/is");

    const put = yield* HttpClient.execute(
      HttpClientRequest.put(`${url}/users/${user}/files/notes.md`).pipe(
        HttpClientRequest.bodyText("hello"),
      ),
    );
    expect(((yield* put.json) as { content: string }).content).toBe("hello");

    const notes = yield* run(url, "cat /home/user/notes.md");
    expect(notes.output).toBe("hello");

    // The user's volume was created at runtime: delete it through the API.
    const removed = yield* HttpClient.execute(HttpClientRequest.delete(`${url}/users/${user}`));
    expect(removed.status).toBe(204);
  }),
  { timeout: 600_000 },
);

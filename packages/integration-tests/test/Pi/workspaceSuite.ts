import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

type Result = { readonly tool: string; readonly isError: boolean; readonly text: string };

/** A directory that outlives a stopped sandbox on every platform. */
const dir = "/var/tmp/pi-workspace";

/**
 * The same conversation on one sandbox platform: Pi's own tools and its
 * `grep` and `glob` work on the sandbox's files, the files outlive a
 * suspend, and a removed sandbox is replaced by an empty one. The model
 * runs on the Worker's AI binding, with no gateway.
 */
export const workspaceSuite = (options: {
  readonly platform: string;
  readonly providers: Layer.Layer<any, never, Alchemy.StackServices>;
  readonly api: Effect.Effect<{ readonly url: Alchemy.Output<string | undefined> }, any, any>;
}) => {
  const { platform, providers } = options;
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

  const Stack = Alchemy.Stack(
    `Pi${platform}WorkspaceStack`,
    { providers, state: Cloudflare.state() },
    Effect.gen(function* () {
      const api = yield* options.api;
      return { url: api.url.as<string>() };
    }),
  );

  // The first deploy builds the platform's base image.
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

  /** Call the fixture's API; retries ride through a fresh workers.dev URL's first seconds. */
  const call = (path: string, body?: unknown) =>
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const request =
        body === undefined
          ? HttpClientRequest.get(`${url}${path}`)
          : HttpClientRequest.post(`${url}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
      const response = yield* HttpClient.filterStatusOk(client)
        .execute(request)
        .pipe(
          Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
          // Say what the fixture answered: a bare status hides the cause.
          Effect.catch(() =>
            Effect.flatMap(client.execute(request), (failed) =>
              Effect.flatMap(failed.text, (text) =>
                Effect.die(new Error(`${path} returned ${failed.status}: ${text.slice(0, 2000)}`)),
              ),
            ),
          ),
        );
      return (yield* response.json) as any;
    });

  test(
    `Pi's coding tools run in a ${platform} sandbox that suspends, resumes and is removed`,
    Effect.gen(function* () {
      const name = `ws-${Date.now()}`;
      const route = (action: string) => `/${name}/${action}`;
      let requests = 0;
      /** Send an input and return the results of the tool calls it made. */
      const prompt = Effect.fn(function* (text: string) {
        const before = ((yield* call(route("results"))) as ReadonlyArray<Result>).length;
        const { status } = yield* call(route("prompt"), { text, requestId: `ws-${++requests}` });
        expect(status).toBe("done");
        return ((yield* call(route("results"))) as ReadonlyArray<Result>).slice(before);
      });
      /** What the tool printed when it worked. A failure shows every result of the input. */
      const succeeded = (results: ReadonlyArray<Result>, tool: string) => {
        const worked = results.filter((result) => result.tool === tool && !result.isError);
        // Comparing prints every result of the input, which says why the tool failed.
        if (worked.length === 0) expect(results).toEqual(`a successful ${tool} result`);
        return worked.map((result) => result.text).join("\n");
      };

      yield* call(route("create"), {});
      yield* Effect.gen(function* () {
        const wrote = yield* prompt(
          `Use the write tool to create ${dir}/alpha.txt containing exactly the text "needle-7391".`,
        );
        succeeded(wrote, "write");

        // Pi has no search tools of its own: these are `Pi.Grep` and `Pi.Glob`.
        const searched = yield* prompt(
          `Use the grep tool once, with pattern "needle-7391" and path "${dir}".`,
        );
        expect(succeeded(searched, "grep")).toContain("alpha.txt");
        const globbed = yield* prompt(
          `Use the glob tool once, with pattern "**/*.txt" and path "${dir}".`,
        );
        expect(succeeded(globbed, "glob")).toContain("alpha.txt");

        // Suspending twice is the same as once, and the next tool call finds the file.
        yield* call(route("suspend"), {});
        yield* call(route("suspend"), {});
        const resumed = yield* prompt(`Use bash to run: cat ${dir}/alpha.txt`);
        expect(succeeded(resumed, "bash")).toContain("needle-7391");

        // Removing twice is the same as once, and the next tool call gets an empty sandbox.
        yield* call(route("remove"), {});
        yield* call(route("remove"), {});
        const fresh = yield* prompt(`Use bash to run: ls ${dir}; echo listed`);
        expect(succeeded(fresh, "bash")).toContain("listed");
        expect(succeeded(fresh, "bash")).not.toContain("alpha.txt");
        // A failed assertion must not leave a sandbox running.
      }).pipe(Effect.ensuring(Effect.ignore(call(route("remove"), {}))));
    }),
    {
      tags: ["provider:cloudflare", "provider:pi", `provider:${platform}`, "live"],
      timeout: 420_000,
    },
  );
};

import { Services, Credentials, credentials } from "@distilled.cloud/forgejo";
import type { Input } from "@/Input.ts";
import type { ScratchStack } from "@/Test/Core.ts";
import { State, isResourceState } from "@/State/State.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import { runtimeRequests } from "./runtime-providers.ts";
import * as Schedule from "effect/Schedule";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { expect } from "alchemy-test";
import type { RepositoryAttributes } from "@/Forgejo/Repository.ts";

export const logDeliveryStatus = Effect.gen(function* () {
  const runner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* runner.spawn(
    ChildProcess.make(
      "docker",
      [
        "exec",
        "alchemy-forgejo-1425",
        "sqlite3",
        "-readonly",
        "/data/gitea/gitea.db",
        "SELECT event_type,is_delivered,is_succeed,json_extract(response_content,'$.status'), CASE WHEN json_extract(response_content,'$.body') IN ('invalid signature','invalid event payload','unsupported event','Internal Server Error') THEN json_extract(response_content,'$.body') ELSE 'other response' END FROM hook_task ORDER BY id DESC LIMIT 20;",
      ],
      { stdout: "pipe", stderr: "ignore" },
    ),
  );
  const diagnostics = yield* child.stdout.pipe(
    Stream.decodeText,
    Stream.mkString,
  );
  yield* child.exitCode;
  yield* Effect.logWarning(
    "Forgejo delivery status (no payloads or credentials)",
    diagnostics,
  );
});

const rows = (stack: ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const keys = yield* state.list({ stack: stack.name, stage: stack.stage });
    const values = yield* Effect.forEach(keys, (fqn) =>
      state.get({ stack: stack.name, stage: stack.stage, fqn }),
    );
    return values.filter(
      (value): value is ResourceState =>
        value !== undefined && isResourceState(value),
    );
  }).pipe(Effect.provide(stack.state));

export const verifyRuntime = <A, E, R, Retained>(
  stack: ScratchStack,
  program: Effect.Effect<A, E, R>,
  retainRepositories: Effect.Effect<unknown, never, Retained>,
) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    yield* stack.deploy(retainRepositories);
    const legacyIds = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      const keys = yield* state.list({ stack: stack.name, stage: stack.stage });
      const ids: number[] = [];
      for (const fqn of keys) {
        const key = { stack: stack.name, stage: stack.stage, fqn };
        const row = yield* state.get(key);
        if (
          row &&
          isResourceState(row) &&
          row.resourceType === "Forgejo.Repository" &&
          row.attr
        ) {
          const { owner, name, apiBaseUrl, ...attr } = row.attr;
          ids.push(attr.repoId);
          yield* state.set({ ...key, value: { ...row, attr } });
        }
      }
      return ids;
    }).pipe(Effect.provide(stack.state));
    const deployment = yield* stack.deploy(program);
    const {
      url: rawUrl,
      repository: repo,
      other,
    } = deployment as Input.Resolve<A> & {
      url: string;
      repository: RepositoryAttributes;
      other: RepositoryAttributes;
    };
    expect(legacyIds.sort()).toEqual([repo.repoId, other.repoId].sort());
    expect(repo.owner).toBe("alchemy-admin");
    expect(repo.name).toBeDefined();
    expect(repo.apiBaseUrl).toMatch(/^https:\/\//);
    const url = rawUrl.replace(/\/$/, "");
    yield* HttpClient.get(`${url}/health`).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.text.pipe(
              Effect.flatMap((body) =>
                body === "ok"
                  ? Effect.void
                  : Effect.fail(
                      new Error("Host initialization has not propagated"),
                    ),
              ),
            )
          : Effect.fail(new Error(`Host not ready: ${response.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
    );
    const deployedHook = (yield* rows(stack)).find(
      (row) => row.resourceType === "Forgejo.Webhook",
    )!;
    yield* HttpClient.post(deployedHook.attr!.url).pipe(
      Effect.flatMap((response) =>
        response.status === 401
          ? Effect.void
          : Effect.fail(
              new Error(`Webhook receiver not ready: ${response.status}`),
            ),
      ),
      Effect.retry({ times: 8, schedule: Schedule.spaced("2 seconds") }),
    );
    const get = (path: string) =>
      HttpClient.get(`${url}${path}`).pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            const body = yield* response.json;
            expect(response.status).toBe(200);
            expect(body).not.toHaveProperty("error");
            return body;
          }),
        ),
      );
    expect(yield* get("/read")).toMatchObject({
      id: repo.repoId,
      name: repo.name,
    });
    expect(yield* get("/other")).toMatchObject({ id: other.repoId });
    // Forgejo 16 caps repository-restricted tokens below repository-admin access.
    for (const path of ["/topics/write", "/topics/read-write"]) {
      const denied = yield* HttpClient.get(`${url}${path}`).pipe(
        Effect.flatMap((response) => response.json),
      );
      expect(denied).toMatchObject({
        error: "Forbidden",
      });
    }
    expect(yield* get("/topics")).toMatchObject({ topics: [] });
    const target = { owner: repo.owner, repo: repo.name };
    yield* get("/file/create");
    let file = yield* Services.repository.repoGetContents({
      ...target,
      filepath: "runtime.txt",
    });
    expect(yield* get("/content")).toMatchObject({ sha: file.sha });
    yield* get(`/file/update?sha=${file.sha}`);
    file = yield* Services.repository.repoGetContents({
      ...target,
      filepath: "runtime.txt",
    });
    expect(file.content?.trim()).toBe("dXBkYXRlZA==");
    yield* get(`/file/delete?sha=${file.sha}`);
    expect(
      yield* Services.repository
        .repoGetContents({ ...target, filepath: "runtime.txt" })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
    ).toBe(true);
    yield* get("/issues/create");
    const issue = (yield* Services.issue.listIssues(target)).find(
      (issue) => issue.title === "runtime issue",
    )!;
    expect(issue).toBeDefined();
    expect(yield* get(`/issues/get?index=${issue.number}`)).toMatchObject({
      id: issue.id,
    });
    yield* get(`/issues/update?index=${issue.number}`);
    yield* get(`/issues/comment?index=${issue.number}`);
    expect(
      yield* get(`/issues/read-write?index=${issue.number}`),
    ).toMatchObject({ body: "combined client" });
    expect(yield* get("/issues")).toBeInstanceOf(Array);
    expect(yield* get(`/issues/comments?index=${issue.number}`)).toBeInstanceOf(
      Array,
    );
    const comments = yield* Services.issue
      .issueGetComments({ ...target, index: issue.number! })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
          until: (comments) =>
            comments.some((comment) =>
              comment.body?.startsWith("received issues "),
            ),
        }),
      );
    if (
      !comments.some((comment) => comment.body?.startsWith("received issues "))
    ) {
      yield* logDeliveryStatus;
    }
    expect(
      comments.some((comment) => comment.body?.startsWith("received issues ")),
    ).toBe(true);
    const pushed = yield* Services.issue.listIssues(target).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        times: 8,
        until: (issues) =>
          issues.some((issue) => issue.title?.startsWith("received push ")),
      }),
    );
    expect(
      pushed.some((issue) => issue.title?.startsWith("received push ")),
    ).toBe(true);
    const initial = yield* rows(stack);
    const tokens = initial.filter(
      (row) => row.resourceType === "Forgejo.ApiToken",
    );
    const secrets = initial.filter(
      (row) => row.resourceType === "Alchemy.Random",
    );
    const hooks = initial.filter(
      (row) => row.resourceType === "Forgejo.Webhook",
    );
    expect(tokens).toHaveLength(5);
    expect(secrets).toHaveLength(1);
    expect(hooks).toHaveLength(1);
    const bootstrap = yield* yield* Credentials;
    for (const token of tokens) {
      expect(Redacted.isRedacted(token.attr!.token)).toBe(true);
      expect(
        Redacted.value(token.attr!.token) === Redacted.value(bootstrap.token),
      ).toBe(false);
      expect(token.props!.repositories).toHaveLength(1);
    }
    const host = initial.find(
      (row) =>
        row.resourceType === "Cloudflare.Worker" ||
        row.resourceType === "AWS.Lambda.Function",
    )!;
    const boundEnvironment = yield* Effect.sync(() => {
      const strings = (value: unknown): string[] =>
        Redacted.isRedacted(value)
          ? strings(Redacted.value(value))
          : typeof value === "string"
            ? [value]
            : Array.isArray(value)
              ? value.flatMap(strings)
              : value !== null && typeof value === "object"
                ? Object.values(value).flatMap(strings)
                : [];
      return strings([host.props!.env, host.bindings]).join("\n");
    });
    expect(boundEnvironment.includes(Redacted.value(bootstrap.token))).toBe(
      false,
    );
    for (const token of tokens)
      expect(boundEnvironment.includes(Redacted.value(token.attr!.token))).toBe(
        true,
      );
    const reader = tokens.find(
      (row) =>
        row.props!.scopes[0] === "read:repository" &&
        row.props!.repositories[0].name === repo.name,
    )!;
    const asReader = credentials({
      baseUrl: bootstrap.apiBaseUrl,
      token: reader.attr!.token,
    });
    expect(
      yield* Services.repository
        .repoCreateFile({
          ...target,
          filepath: "forbidden.txt",
          content: "bm8=",
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("Forbidden", () => Effect.succeed(true)),
          Effect.provide(asReader),
        ),
    ).toBe(true);
    expect(
      yield* Services.repository
        .getRepo({ owner: other.owner, repo: other.name })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.provide(asReader),
        ),
    ).toBe(true);
    const issueReader = tokens.find(
      (row) => row.props!.scopes[0] === "read:issue",
    )!;
    expect(
      yield* Services.issue.createIssue({ ...target, title: "forbidden" }).pipe(
        Effect.as(false),
        Effect.catchTag("Forbidden", () => Effect.succeed(true)),
        Effect.provide(
          credentials({
            baseUrl: bootstrap.apiBaseUrl,
            token: issueReader.attr!.token,
          }),
        ),
      ),
    ).toBe(true);
    const listed = yield* Services.admin.adminListUserAccessTokens({
      username: "alchemy-admin",
    });
    for (const token of tokens) {
      const remote = listed.find((item) => item.id === token.attr!.tokenId)!;
      expect(remote.scopes).toEqual(token.props!.scopes);
    }
    const hookUrl = hooks[0]!.attr!.url as string;
    expect((yield* HttpClient.post(hookUrl)).status).toBe(401);
    expect(
      (yield* HttpClient.execute(
        HttpClientRequest.post(hookUrl).pipe(
          HttpClientRequest.setHeader("x-forgejo-signature", "0".repeat(64)),
          HttpClientRequest.bodyText("{}"),
        ),
      )).status,
    ).toBe(401);
    const signAndSend = (
      body: string,
      signingSecret: Redacted.Redacted<string>,
      event = "issues",
    ) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.sync(() => new TextEncoder().encode(body));
        const keyBytes = yield* Effect.sync(() =>
          new TextEncoder().encode(Redacted.value(signingSecret)),
        );
        const key = yield* Effect.promise(() =>
          crypto.subtle.importKey(
            "raw",
            keyBytes,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          ),
        );
        const digest = yield* Effect.promise(() =>
          crypto.subtle.sign("HMAC", key, bytes),
        );
        const signature = yield* Effect.sync(() =>
          Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
        );
        return (yield* HttpClient.execute(
          HttpClientRequest.post(hookUrl).pipe(
            HttpClientRequest.setHeaders({
              "x-forgejo-signature": signature,
              "x-forgejo-event": event,
              "x-forgejo-delivery": "runtime-negative-controls",
            }),
            HttpClientRequest.bodyText(body),
          ),
        )).status;
      });
    const secret = secrets[0]!.attr!.text as Redacted.Redacted<string>;
    expect(yield* signAndSend("{", secret)).toBe(400);
    expect(yield* signAndSend("{}", secret)).toBe(400);
    expect(yield* signAndSend("{}", secret, "unsupported")).toBe(422);
    const observedRepo = yield* Services.repository.getRepo(target);
    const validBody = yield* Effect.sync(() =>
      JSON.stringify({
        action: "edited",
        issue: { ...issue, body: "unicode π" },
        repository: observedRepo,
        sender: observedRepo.owner,
      }),
    );
    expect(yield* signAndSend(validBody, secret)).toBe(202);
    expect(yield* signAndSend(validBody, Redacted.make("wrong-secret"))).toBe(
      401,
    );
    expect((yield* HttpClient.get(hookUrl)).status).toBe(405);
    expect(yield* get("/unrelated")).toEqual({ unrelated: true });
    yield* stack.deploy(program);
    const unchanged = yield* rows(stack);
    expect(
      unchanged
        .filter((row) => row.resourceType === "Forgejo.ApiToken")
        .map((row) => row.attr!.tokenId)
        .sort(),
    ).toEqual(tokens.map((row) => row.attr!.tokenId).sort());
    expect(
      unchanged.find((row) => row.resourceType === "Alchemy.Random")!.attr!
        .text,
    ).toEqual(secrets[0]!.attr!.text);
    const config = yield* ConfigProvider.ConfigProvider;
    const replacementSecret = "forgejo-runtime-external-rotation-secret";
    const rotate = program.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({
            FORGEJO_TEST_ROTATION: "two",
            FORGEJO_TEST_WEBHOOK_SECRET: replacementSecret,
          }),
          config,
        ),
      ),
    );
    yield* Effect.sync(() => {
      runtimeRequests.length = 0;
    });
    yield* stack.deploy(rotate);
    const rotatedRows = yield* rows(stack);
    const rotatedTokens = rotatedRows.filter(
      (row) => row.resourceType === "Forgejo.ApiToken",
    );
    expect(rotatedTokens).toHaveLength(tokens.length);
    expect(
      rotatedTokens.filter(
        (row) => !tokens.some((old) => old.attr!.tokenId === row.attr!.tokenId),
      ),
    ).toHaveLength(1);
    expect(
      rotatedRows.find((row) => row.resourceType === "Forgejo.Webhook")!.attr!
        .webhookId,
    ).not.toBe(hooks[0]!.attr!.webhookId);
    const mint = runtimeRequests.findIndex(
      (request) =>
        request.method === "POST" &&
        request.path.endsWith("/admin/users/alchemy-admin/tokens"),
    );
    const revoke = runtimeRequests.findIndex(
      (request) =>
        request.method === "DELETE" &&
        request.path.endsWith(`/tokens/${reader.attr!.tokenId}`),
    );
    const upload = runtimeRequests.findIndex(
      (request) =>
        request.method === "PUT" &&
        (/\/workers\/scripts\//.test(request.path) ||
          /\/functions\/.*\/code$/.test(request.path)),
    );
    expect(mint).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(mint);
    expect(revoke).toBeGreaterThan(upload);
    const removeHook = runtimeRequests.findIndex(
      (request) =>
        request.method === "DELETE" &&
        request.path.endsWith(`/hooks/${hooks[0]!.attr!.webhookId}`),
    );
    const createHook = runtimeRequests.findIndex(
      (request) => request.method === "POST" && request.path.endsWith("/hooks"),
    );
    expect(removeHook).toBeGreaterThanOrEqual(0);
    expect(createHook).toBeGreaterThan(removeHook);
    const rotatedRead = yield* HttpClient.get(`${url}/read`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        times: 8,
        schedule: Schedule.spaced("2 seconds"),
        until: (body) =>
          typeof body === "object" &&
          body !== null &&
          "id" in body &&
          body.id === repo.repoId,
      }),
    );
    expect(rotatedRead).toMatchObject({ id: repo.repoId });
    // Worker rollout can briefly serve both credential generations.
    let stableResponses = 0;
    yield* Effect.gen(function* () {
      const current = yield* signAndSend(
        validBody,
        Redacted.make(replacementSecret),
      );
      const previous = yield* signAndSend(validBody, secret);
      stableResponses =
        current === 202 && previous === 401 ? stableResponses + 1 : 0;
      return stableResponses;
    }).pipe(
      Effect.repeat({
        times: 8,
        schedule: Schedule.spaced("5 seconds"),
        until: (count) => count >= 3,
      }),
    );
    expect(stableResponses).toBeGreaterThanOrEqual(3);
    const rotatedIssue = yield* Services.issue.createIssue({
      ...target,
      title: "rotated delivery",
    });
    const rotatedComments = yield* Services.issue
      .issueGetComments({ ...target, index: rotatedIssue.number! })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 8,
          until: (comments) =>
            comments.some((comment) =>
              comment.body?.startsWith("received issues "),
            ),
        }),
      );
    const delivered = rotatedComments.some((comment) =>
      comment.body?.startsWith("received issues "),
    );
    if (!delivered) yield* logDeliveryStatus;
    expect(delivered).toBe(true);
    yield* stack.deploy(retainRepositories);
    expect((yield* Services.repository.getRepo(target)).id).toBe(repo.repoId);
    expect(yield* Services.repository.repoListHooks(target)).toEqual([]);
    expect(
      (yield* rows(stack)).some(
        (row) => row.resourceType === "Forgejo.ApiToken",
      ),
    ).toBe(false);
    yield* stack.destroy();
    expect(
      yield* Services.repository.getRepo(target).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      ),
    ).toBe(true);
    const remaining = yield* Services.admin.adminListUserAccessTokens({
      username: "alchemy-admin",
    });
    expect(
      remaining.some((item) =>
        [...tokens, ...rotatedTokens].some(
          (token) => token.attr!.tokenId === item.id,
        ),
      ),
    ).toBe(false);
  });

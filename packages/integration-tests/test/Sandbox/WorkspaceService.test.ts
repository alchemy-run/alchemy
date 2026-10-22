import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Region from "@distilled.cloud/aws/Region";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ServiceWorkspaceStack, { providers, state } from "./fixtures/workspace-service/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });

interface Exec {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Result extends Exec {
  readonly changes: {
    readonly status: string;
    readonly paths: ReadonlyArray<string>;
    readonly fork?: string;
  };
  readonly stopped?: ReadonlyArray<{ readonly command: string }>;
  readonly timings?: Readonly<Record<string, number>>;
}

const options = { tags: ["live", "provider:cloudflare", "provider:aws"], timeout: 900_000 };

// A Cloudflare Worker using a workspace whose hosts are EC2 spot instances.
describe.skipIf(!!process.env.FAST).sequential("AWS.Workspace: hosts on EC2, from a Worker", () => {
  const stack = beforeAll(deploy(ServiceWorkspaceStack), { timeout: 2_400_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ServiceWorkspaceStack), {
    timeout: 1_500_000,
  });

  const call = <A>(op: string, body: Record<string, string>) =>
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      return yield* client
        .execute(
          HttpClientRequest.post(new URL(op, url)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        )
        .pipe(
          Effect.flatMap((r) =>
            r.status !== 200
              ? r.text.pipe(
                  Effect.flatMap((text) => Effect.fail(new Error(`${op} ${r.status}: ${text}`))),
                )
              : Effect.map(r.json, (json) => (json as { result: A }).result),
          ),
          Effect.timeout("600 seconds"),
        );
    });

  test(
    "a command runs on the image, in the workspace, and the next one sees what it wrote",
    Effect.gen(function* () {
      // The first request waits for a host to come up and set itself up.
      const first = yield* call<Result>("exec", {
        session: "s1",
        command: "cat motd; uname -m; node --version | cut -c1-3; echo one > a.txt",
      }).pipe(Effect.retry({ schedule: Schedule.spaced("15 seconds"), times: 40 }));
      expect(first.exitCode, first.stderr).toBe(0);
      expect(first.stdout.trim().split("\n")).toEqual(["base", "aarch64", "v24"]);
      expect(first.changes).toEqual({ status: "applied", paths: ["a.txt"] });
      console.log(`first command's timings: ${JSON.stringify(first.timings)}`);
      const second = yield* call<Result>("exec", { session: "s1", command: "cat a.txt" });
      expect(second.stdout.trim()).toBe("one");
      console.log(`a warm command's timings: ${JSON.stringify(second.timings)}`);
    }),
    options,
  );

  test(
    "commands at once land, and the one that collides is refused whole and kept",
    Effect.gen(function* () {
      const started = Date.now();
      const results = yield* call<ReadonlyArray<Result>>("fanout", {
        session: "s1",
        commands: JSON.stringify([
          "echo 1 > x-1.txt && sleep 2",
          "echo 2 > x-2.txt && sleep 2",
          "sleep 2 && echo left > same.txt",
          "sleep 2 && echo right > same.txt",
        ]),
      });
      console.log(`4 commands of 2 s at once on EC2: ${Date.now() - started} ms`);
      for (const result of results) console.log(`  ${JSON.stringify(result.timings)}`);
      expect(results.slice(0, 2).map((r) => r.changes.status)).toEqual(["applied", "applied"]);
      const same = results.slice(2).map((r) => r.changes.status);
      expect([...same].sort()).toEqual(["applied", "conflict"]);
      const refused = results.slice(2).find((r) => r.changes.status === "conflict")!;
      expect(refused.changes.paths).toEqual(["same.txt"]);
      expect(refused.changes.fork).toBeDefined();
      const read = yield* call<Result>("exec", { session: "s1", command: "cat x-1.txt x-2.txt" });
      expect(read.stdout.trim().split("\n")).toEqual(["1", "2"]);
      const kept = yield* call<Result>("exec", {
        session: refused.changes.fork!,
        command: "cat same.txt",
      });
      expect(["left", "right"]).toContain(kept.stdout.trim());
    }),
    options,
  );

  test(
    "a command that leaves a process running keeps it, and later commands see what it writes",
    Effect.gen(function* () {
      yield* call("delete", { session: "s2" }).pipe(Effect.ignore);
      const started = yield* call<Result>("exec", {
        session: "s2",
        command:
          "(setsid sh -c 'for i in 1 2 3 4 5 6; do echo $i >> bg.log; sleep 1; done' < /dev/null > /dev/null 2>&1 &); echo ok",
      });
      expect(started.stopped).toBeUndefined();
      yield* Effect.sleep("2 seconds");
      const midway = yield* call<Result>("exec", { session: "s2", command: "wc -l < bg.log" });
      expect(Number(midway.stdout.trim())).toBeGreaterThan(0);
      yield* Effect.sleep("12 seconds");
      const after = yield* call<Result>("exec", { session: "s2", command: "wc -l < bg.log" });
      expect(Number(after.stdout.trim())).toBe(6);
    }),
    options,
  );

  test(
    "an open runs commands on the session's mount and reaches a server on its port",
    Effect.gen(function* () {
      const opened = yield* call<Exec>("open", { session: "s1", command: "cat a.txt x-1.txt" });
      expect(opened.stdout.trim().split("\n")).toEqual(["one", "1"]);
      const served = yield* call<string>("port", { session: "s1" });
      expect(served).toBe("from /hello");
    }),
    options,
  );

  test(
    "fork, merge, history, undo and delete",
    Effect.gen(function* () {
      yield* call("delete", { session: "s3" }).pipe(Effect.ignore);
      yield* call("fork", { session: "s1", to: "s3" });
      yield* call<Result>("exec", { session: "s3", command: "echo forked > from-fork.txt" });
      const merged = yield* call<{
        readonly status: string;
        readonly paths: ReadonlyArray<string>;
      }>("merge", { session: "s3", into: "s1" });
      expect(merged.status).toBe("applied");
      expect(merged.paths).toContain("from-fork.txt");
      const seen = yield* call<Result>("exec", { session: "s1", command: "cat from-fork.txt" });
      expect(seen.stdout.trim()).toBe("forked");
      const history = yield* call<ReadonlyArray<string>>("history", { session: "s1" });
      expect(history.length).toBeGreaterThan(1);
      yield* call("undo", { session: "s1" });
      const undone = yield* call<Result>("exec", {
        session: "s1",
        command: "cat from-fork.txt 2>/dev/null || echo gone",
      });
      expect(undone.stdout.trim()).toBe("gone");
      yield* call("delete", { session: "s3" });
    }),
    options,
  );

  test(
    "a command has a network of its own: out to the internet, not to the host's credentials, the hosts or the VPC",
    Effect.gen(function* () {
      // Both hosts' addresses, from the registry.
      const { TableNames } = yield* dynamodb.listTables({});
      const table = TableNames!.find((name) =>
        name.toLowerCase().includes("serviceworkspaceregistry"),
      )!;
      const { Items } = yield* dynamodb.scan({ TableName: table });
      const hosts = (Items ?? [])
        .filter((item) => item.pk?.S?.startsWith("host#"))
        .map((item) => item.address!.S!);
      expect(hosts.length).toBe(2);
      const urls = [
        "https://example.com/",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.200.0.1:8080/health",
        ...hosts.map((address) => `http://${address}/health`),
      ];
      const probe = urls
        .map(
          (url) =>
            `fetch('${url}', { signal: AbortSignal.timeout(3000) }).then((r) => 'reached ' + r.status, () => 'unreachable')`,
        )
        .join(", ");
      const result = yield* call<Result>("exec", {
        session: "s6",
        command: `node -e "Promise.all([${probe}]).then((all) => console.log(all.join('\\n')))"`,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "reached 200",
        ...urls.slice(1).map(() => "unreachable"),
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(Credentials.fromChain(), Region.fromEnv()))),
    options,
  );

  test(
    "when the host that has a session dies, another host takes it over, with its files",
    Effect.gen(function* () {
      yield* call("delete", { session: "s5" }).pipe(Effect.ignore);
      yield* call<Result>("exec", { session: "s5", command: "echo survives > kept.txt" });
      // Which host has it: the registry, read out of band.
      const { TableNames } = yield* dynamodb.listTables({});
      const table = TableNames!.find((name) =>
        name.toLowerCase().includes("serviceworkspaceregistry"),
      )!;
      const { Item } = yield* dynamodb.getItem({
        TableName: table,
        Key: { pk: { S: "session#s5" } },
        ConsistentRead: true,
      });
      const owner = Item!.host!.S!;
      yield* ec2.terminateInstances({ InstanceIds: [owner] });
      // Until the other host claims it (its claim lapses within a minute).
      const after = yield* call<Result>("exec", { session: "s5", command: "cat kept.txt" }).pipe(
        Effect.filterOrFail(
          (r) => r.exitCode === 0,
          (r) => new Error(`not yet: ${r.stderr}`),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 24 }),
      );
      expect(after.stdout.trim()).toBe("survives");
      const { Item: moved } = yield* dynamodb.getItem({
        TableName: table,
        Key: { pk: { S: "session#s5" } },
        ConsistentRead: true,
      });
      expect(moved!.host!.S).not.toBe(owner);
    }).pipe(
      // The registry and the instance, out of band, as the test's own AWS identity.
      Effect.provide(Layer.mergeAll(Credentials.fromChain(), Region.fromEnv())),
    ),
    options,
  );
});

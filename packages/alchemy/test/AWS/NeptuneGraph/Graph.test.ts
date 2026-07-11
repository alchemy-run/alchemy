import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import NeptuneGraphTestFunctionLive, {
  FixtureGraph,
  NeptuneGraphTestFunction,
} from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete/wait paths depend on. Runs in
// every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getGraph on a nonexistent graph fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        // Well-formed but nonexistent graph id (g-<10 alphanumerics>).
        neptunegraph.getGraph({ graphIdentifier: "g-0123456789" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGraphGone = (graphId: string) =>
  neptunegraph.getGraph({ graphIdentifier: graphId }).pipe(
    Effect.flatMap((graph) =>
      Effect.fail(
        new Error(`graph '${graphId}' still exists (status: ${graph.status})`),
      ),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.fixed("10 seconds").pipe(
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
  );

// A Neptune Analytics graph takes ~5-10 minutes to provision and bills per
// m-NCU-hour (16 m-NCUs here) while it exists. The full lifecycle — graph +
// Lambda running openCypher through the ExecuteQuery binding — is gated
// behind AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create graph, query it from Lambda via ExecuteQuery, destroy",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { graph, fn } = yield* stack.deploy(
        Effect.gen(function* () {
          const { graph } = yield* FixtureGraph;
          const fn = yield* NeptuneGraphTestFunction;
          return { graph, fn };
        }).pipe(Effect.provide(NeptuneGraphTestFunctionLive)),
      );

      expect(graph.graphId).toMatch(/^g-/);
      expect(graph.graphArn).toContain(":graph/");
      expect(graph.status).toBe("AVAILABLE");
      expect(graph.provisionedMemory).toBe(16);
      expect(graph.publicConnectivity).toBe(true);
      expect(graph.replicaCount).toBe(0);
      expect(graph.deletionProtection).toBe(false);
      expect(graph.endpoint).toContain("neptune-graph");

      // Out-of-band verification via distilled.
      const observed = yield* neptunegraph.getGraph({
        graphIdentifier: graph.graphId,
      });
      expect(observed.status).toBe("AVAILABLE");
      expect(observed.name).toBe(graph.graphName);

      // Drive the deployed Lambda. First request rides URL propagation —
      // bounded retry.
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      const graphInfo = yield* HttpClient.get(`${baseUrl}/graph`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`/graph returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.fixed("3 seconds").pipe(
            Schedule.both(Schedule.recurs(40)),
          ),
        }),
      );
      expect((graphInfo as { graphId: string }).graphId).toBe(graph.graphId);

      // openCypher through the ExecuteQuery binding: write a node, read it
      // back.
      const query = (body: {
        query: string;
        parameters?: Record<string, unknown>;
      }) =>
        HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/query`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : res.text.pipe(
                  Effect.flatMap((text) =>
                    Effect.fail(
                      new Error(`/query returned ${res.status}: ${text}`),
                    ),
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.fixed("3 seconds").pipe(
              Schedule.both(Schedule.recurs(10)),
            ),
          }),
        );

      yield* query({
        query: "CREATE (n:Person {name: $name})",
        parameters: { name: "Ada" },
      });
      const read = (yield* query({
        query: "MATCH (n:Person) RETURN n.name AS name",
      })) as { results: Array<{ name: string }> };
      expect(read.results).toEqual([{ name: "Ada" }]);

      // Destroy immediately — the graph bills while it exists — and verify
      // it is fully gone out-of-band.
      yield* stack.destroy();
      yield* assertGraphGone(graph.graphId);
    }),
  // graph create (~5-10 min) + lambda deploy + delete-until-gone, one test.
  { timeout: 1_500_000 },
);

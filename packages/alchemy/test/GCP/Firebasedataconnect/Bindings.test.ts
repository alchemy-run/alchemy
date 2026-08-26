import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  connectorSource,
  hasGcpCreds,
  logLevel,
  runLifecycle,
  schemaSource,
  unlinkedDatasources,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "ExecuteGraphql and ExecuteQuery round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* GCP.Firebasedataconnect.Service("App", {
            labels: { env: "test" },
          });
          const schema = yield* GCP.Firebasedataconnect.ServicesSchema("Main", {
            service: service.name,
            source: schemaSource(),
            datasources: unlinkedDatasources,
            labels: { env: "test" },
          });
          const connector = yield* GCP.Firebasedataconnect.ServicesConnector(
            "Queries",
            {
              service: schema.service,
              source: {
                files: [
                  ...connectorSource.files,
                  {
                    path: "mutations.gql",
                    content:
                      "mutation CreateAlchemyNote($title: String!) @auth(level: PUBLIC) { alchemyNote_insert(data: { title: $title }) { id } }",
                  },
                ],
              },
              labels: { env: "test" },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* schema.name;
              yield* connector.name;
              const executeGraphql =
                yield* GCP.Firebasedataconnect.ExecuteGraphql(service);
              const executeGraphqlRead =
                yield* GCP.Firebasedataconnect.ExecuteGraphqlRead(service);
              const executeQuery =
                yield* GCP.Firebasedataconnect.ExecuteQuery(connector);
              const executeMutation =
                yield* GCP.Firebasedataconnect.ExecuteMutation(connector);
              return Effect.fn(function* () {
                const graphql = yield* executeGraphql({
                  body: { query: "{ __typename }" },
                });
                const graphqlRead = yield* executeGraphqlRead({
                  body: { query: "{ __typename }" },
                });
                const query = yield* executeQuery({
                  body: { operationName: "ListAlchemyNotes" },
                });
                const mutation = yield* executeMutation({
                  body: {
                    operationName: "CreateAlchemyNote",
                    variables: { title: "hello" },
                  },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return { graphql, graphqlRead, query, mutation };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.graphql).toBeDefined();
      expect(out.graphqlRead).toBeDefined();
      expect(out.query).toBeDefined();
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.mutation.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

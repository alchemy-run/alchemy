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
              source: connectorSource,
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
              const executeQuery =
                yield* GCP.Firebasedataconnect.ExecuteQuery(connector);
              return Effect.fn(function* () {
                const graphql = yield* executeGraphql({
                  body: { query: "{ __typename }" },
                });
                const query = yield* executeQuery({
                  body: { operationName: "ListAlchemyNotes" },
                });
                return { graphql, query };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.graphql).toBeDefined();
      expect(out.query).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

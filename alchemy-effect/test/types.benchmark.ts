import * as Alchemy from "@/index";

import * as DynamoDB from "@/aws/dynamodb";
import * as Lambda from "@/aws/lambda";
import * as SQS from "@/aws/sqs";
import { $, type, Policy } from "@/index";
import { bench } from "@ark/attest";
import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as AWS from "alchemy-effect/aws";
import * as CLI from "alchemy-effect/cli";
import { Layer, Logger } from "effect";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

bench("Lambda.serve with no bindings", () => {
  class Api extends Lambda.serve("Api", {
    fetch: Effect.fn(function* (event) {
      return {
        body: JSON.stringify({ message: "Hello, world!" }),
      };
    }),
  })({
    main: import.meta.filename,
    bindings: $(),
  }) {}
}).types([11, "instantiations"]);

bench("Lambda.serve with a SQS.Queue binding", () => {
  class Queue extends SQS.Queue("Queue", {
    fifo: true,
    schema: S.String,
  }) {}
  class Api extends Lambda.serve("Api", {
    fetch: Effect.fn(function* (event) {
      yield* SQS.sendMessage(Queue, "hello").pipe(
        Effect.catchAll(() => Effect.void),
      );
      return {
        body: JSON.stringify({ message: "Hello, world!" }),
      };
    }),
  })({
    main: import.meta.filename,
    bindings: $(SQS.SendMessage(Queue)),
  }) {}
}).types([19, "instantiations"]);

bench("Lambda.serve with a DynamoDB.Table binding", () => {
  class Table extends DynamoDB.Table("Table", {
    partitionKey: "id",
    sortKey: "name",
    items: type<{ id: string; name: string }>,
    attributes: {
      id: S.String,
      name: S.String,
    },
  }) {}

  class Api extends Lambda.serve("Api", {
    fetch: Effect.fn(function* (event) {
      const item = yield* DynamoDB.getItem({
        table: Table,
        key: {
          id: "1",
          name: "hello",
        },
      }).pipe(Effect.catchAll(() => Effect.void));
      return {
        body: JSON.stringify(item?.Item),
      };
    }),
  })({
    main: import.meta.filename,
    bindings: $(
      DynamoDB.GetItem(Table, {
        leadingKeys: $.anyOf("1"),
      }),
    ),
  }) {}
}).types([19, "instantiations"]);

bench("plan apply a Lambda.serve with a DynamoDB.Table binding", () => {
  const platform = Layer.mergeAll(
    NodeContext.layer,
    FetchHttpClient.layer,
    Logger.pretty,
  );

  class Table extends DynamoDB.Table("Table", {
    partitionKey: "id",
    sortKey: "name",
    items: type<{ id: string; name: string }>,
    attributes: {
      id: S.String,
      name: S.String,
    },
  }) {}

  class Api extends Lambda.serve("Api", {
    fetch: Effect.fn(function* (event) {
      const item = yield* DynamoDB.getItem({
        table: Table,
        key: {
          id: "1",
          name: "hello",
        },
      }).pipe(Effect.catchAll(() => Effect.void));
      return {
        body: JSON.stringify(item?.Item),
      };
    }),
  })({
    main: import.meta.filename,
    bindings: $(
      DynamoDB.GetItem(Table, {
        leadingKeys: $.anyOf("1"),
      }),
    ),
  }) {}

  Alchemy.apply(Api).pipe(
    Effect.tap((stack) =>
      Effect.log({
        url: stack?.Api.functionUrl,
        // @ts-expect-error - does not exist in stack
        queueUrl: stack?.Messages.queueUrl,
      }),
    ),
  );
}).types([363, "instantiations"]);

bench("AWS.providers", () => {
  const provider = AWS.providers;
}).types([40419, "instantiations"]);

bench("platform and provider layers", () => {
  const platform = Layer.mergeAll(
    NodeContext.layer,
    FetchHttpClient.layer,
    Logger.pretty,
  );

  // select your providers
  const providers = Layer.mergeAll(AWS.providers());

  const alchemy = Layer.mergeAll(
    Alchemy.State.localFs,
    CLI.inkCLI(),
    // optional
    Alchemy.dotAlchemy,
  );

  const app = Alchemy.app({ name: "my-app", stage: "dev", config: {} });

  const layers = Layer.provideMerge(
    Layer.provideMerge(providers, alchemy),
    Layer.mergeAll(platform, app),
  );
}).types([61897, "instantiations"]);

class Table extends DynamoDB.Table("Table", {
  partitionKey: "id",
  sortKey: "name",
  items: type<{ id: string; name: string }>,
  attributes: {
    id: S.String,
    name: S.String,
  },
}) {}

// TODO(sam): why is this 0?
class Api extends Lambda.serve("Api", {
  fetch: Effect.fn(function* (event) {
    const item = yield* DynamoDB.getItem({
      table: Table,
      key: {
        id: "1",
        name: "hello",
      },
    }).pipe(Effect.catchAll(() => Effect.void));
    return {
      body: JSON.stringify(item?.Item),
    };
  }),
})({
  main: import.meta.filename,
  bindings: $(
    DynamoDB.GetItem(Table, {
      leadingKeys: undefined! as Policy.AnyOf<"1">,
    }),
  ),
}) {}

// TODO(sam): why is this 0? I don't trust it
bench("plan", () => {
  const plan = Alchemy.plan(Api);
}).types([19, "instantiations"]);

bench("apply", () => {
  Alchemy.apply(Api).pipe(
    Effect.tap((stack) =>
      Effect.log({
        url: stack?.Api.functionUrl,
        // @ts-expect-error - does not exist in stack
        queueUrl: stack?.Messages.queueUrl,
      }),
    ),
  );
}).types([30, "instantiations"]);

bench("applyPlan", () => {
  Alchemy.plan(Api).pipe(
    Effect.flatMap(Alchemy.applyPlan),
    Effect.tap((stack) =>
      Effect.log({
        url: stack?.Api.functionUrl,
        // @ts-expect-error - does not exist in stack
        queueUrl: stack?.Messages.queueUrl,
      }),
    ),
  );
}).types([30, "instantiations"]);

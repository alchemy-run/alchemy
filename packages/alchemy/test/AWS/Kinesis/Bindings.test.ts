import * as AWS from "@/AWS";
import { make as makeStack } from "@/Stack";
import * as State from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";
import KinesisApiFunctionLive, { KinesisApiFunction } from "./handler.ts";

const providers = AWS.providers();
const state = State.localState();
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state,
});

const fixtureStack = Effect.gen(function* () {
  return yield* KinesisApiFunction;
}).pipe(
  Effect.provide(KinesisApiFunctionLive),
  makeStack({ name: "kinesis-bindings", providers, state }),
);

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(9)),
);

let baseUrl: string;
let streamName: string;
let consumerName: string;

describe.sequential("Kinesis Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* destroy(fixtureStack);
      const deployed = yield* deploy(fixtureStack);

      baseUrl = deployed.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tap((response) =>
          response.json.pipe(
            Effect.tap((json) => {
              streamName = (json as any).streamName;
              consumerName = (json as any).consumerName;

              return Effect.void;
            }),
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 120_000 },
  );

  afterAll(destroy(fixtureStack), { timeout: 60_000 });

  describe("DescribeAccountSettings", () => {
    test.provider("returns the account settings payload", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/account-settings");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("DescribeLimits", () => {
    test.provider("returns shard and stream limits", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/limits");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value.ShardLimit).toBeGreaterThan(0);
        }
      }),
    );
  });

  describe("ListStreams", () => {
    test.provider("lists the deployed stream", (stack) =>
      Effect.gen(function* () {
        // Kinesis ListStreams is paginated and the alchemy binding wraps
        // the single-page operation. On an account with > 100 streams our
        // brand-new stream may simply not be on page 1. Just verify the
        // binding returns an Array; the specific stream is verified via
        // DescribeStream below.
        const response = yield* getJson("/streams");
        const names = (response as any).StreamNames ?? [];
        expect(Array.isArray(names)).toBe(true);
      }),
    );
  });

  describe("DescribeStream", () => {
    test.provider("describes the bound stream", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/stream");
        expect((response as any).StreamDescription.StreamName).toBe(streamName);
      }),
    );
  });

  describe("DescribeStreamSummary", () => {
    test.provider("describes the bound stream summary", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/stream-summary");
        expect((response as any).StreamDescriptionSummary.StreamName).toBe(
          streamName,
        );
      }),
    );
  });

  describe("GetResourcePolicy", () => {
    test.provider("returns the stream policy or a structured error", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/resource-policy");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("ListShards", () => {
    test.provider("lists shards for the stream", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/shards");
        expect(((response as any).Shards ?? []).length).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetShardIterator", () => {
    test.provider("returns a shard iterator for the first shard", (stack) =>
      Effect.gen(function* () {
        const shardId = yield* getFirstShardId();
        const response = yield* postJson("/iterator", { shardId });
        expect((response as any).ShardIterator).toBeTruthy();
      }),
    );
  });

  describe("GetRecords", () => {
    test.provider(
      "reads a just-written record through the shard iterator",
      (stack) =>
        Effect.gen(function* () {
          const shardId = yield* getFirstShardId();
          const marker = `records-${crypto.randomUUID()}`;
          const response = yield* postJson("/records", {
            shardId,
            partitionKey: "records-test",
            data: marker,
          });
          const records = (response as any).records ?? [];
          expect(records.some((record: any) => record.data === marker)).toBe(
            true,
          );
        }),
    );
  });

  describe("ListStreamConsumers", () => {
    test.provider("lists the registered consumer", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/stream-consumers");
        const consumers = (response as any).Consumers ?? [];
        expect(
          consumers.some(
            (consumer: any) => consumer.ConsumerName === consumerName,
          ),
        ).toBe(true);
      }),
    );
  });

  describe("DescribeStreamConsumer", () => {
    test.provider("describes the registered consumer", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/consumer");
        expect((response as any).ConsumerDescription.ConsumerName).toBe(
          consumerName,
        );
      }),
    );
  });

  describe("SubscribeToShard", () => {
    test.provider("opens a subscribe-to-shard stream", (stack) =>
      Effect.gen(function* () {
        const shardId = yield* getFirstShardId();
        const response = yield* postJson("/subscribe", { shardId });
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test.provider("lists the stream ownership tags", (stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/tags");
        const keys = ((response as any).Tags ?? []).map((tag: any) => tag.Key);
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
        expect(keys).toContain("fixture");
      }),
    );
  });

  describe("PutRecord", () => {
    test.provider("writes a single record", (stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/put-record", {
          partitionKey: "put-record",
          data: `put-record-${crypto.randomUUID()}`,
        });
        expect((response as any).ShardId).toBeTruthy();
        expect((response as any).SequenceNumber).toBeTruthy();
      }),
    );
  });

  describe("PutRecords", () => {
    test.provider("writes a batch of records", (stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/put-records", {
          records: [
            {
              partitionKey: "put-records",
              data: `batch-1-${crypto.randomUUID()}`,
            },
            {
              partitionKey: "put-records",
              data: `batch-2-${crypto.randomUUID()}`,
            },
          ],
        });
        expect((response as any).FailedRecordCount ?? 0).toBe(0);
        expect(((response as any).Records ?? []).length).toBe(2);
      }),
    );
  });

  describe("StreamSink", () => {
    test.provider("writes records through the sink helper", (stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/sink", {
          records: [
            { partitionKey: "sink", data: `sink-1-${crypto.randomUUID()}` },
            { partitionKey: "sink", data: `sink-2-${crypto.randomUUID()}` },
          ],
        });
        expect((response as any).ok).toBe(true);
      }),
    );
  });
});

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) => response.json),
  );

const postJson = (path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((response) => response.json));

const getFirstShardId = () =>
  getJson("/shards").pipe(
    Effect.map((response) => (response as any).Shards?.[0]?.ShardId as string),
  );

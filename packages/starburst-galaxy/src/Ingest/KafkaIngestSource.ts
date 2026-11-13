import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  KafkaAuth,
  KafkaIngestSource as KafkaIngestSourceShape,
} from "@distilled.cloud/starburst-galaxy/kafka_ingest_source";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { secretValue } from "../Catalog/CatalogKind.ts";
import {
  changedFields,
  collectAll,
  DATA_DOMAIN_NAME,
  findFirst,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

/** How Galaxy signs in to the brokers. Galaxy refuses unauthenticated Kafka. */
export type KafkaIngestAuth =
  | {
      /** SASL/PLAIN over TLS (Confluent Cloud API keys, for one). */
      readonly type: "saslPlain";
      readonly username: string;
      /** Galaxy never returns it. */
      readonly password: Redacted.Redacted<string>;
    }
  | {
      /** SASL/SCRAM over TLS. */
      readonly type: "saslScram";
      readonly username: string;
      /** Galaxy never returns it. */
      readonly password: Redacted.Redacted<string>;
      readonly scramType: "Sha256" | "Sha512";
    }
  | {
      /** Amazon MSK IAM authentication, as an IAM role Galaxy assumes. */
      readonly type: "iam";
      readonly awsRoleArn: string;
    };

export interface KafkaIngestSourceProps {
  /**
   * Source name. Renaming updates the source in place.
   * @default generated from the stack, logical id and stage
   */
  readonly name?: string;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /** Bootstrap brokers, `host:port`. Changing them replaces the source. */
  readonly brokers: ReadonlyArray<string>;
  /**
   * How Galaxy signs in. Galaxy never returns credentials: a change is
   * detected against the last deploy and sent.
   */
  readonly auth: KafkaIngestAuth;
  /** Galaxy cloud region that reads the topics, e.g. `aws-us-east1`. Changing it replaces the source. */
  readonly cloudRegionId?: string;
}

export interface KafkaIngestSourceAttributes {
  /** Galaxy's source ID (`is-…`): pass it to a `LiveTable`. */
  readonly kafkaIngestSourceId: string;
  /** Source name. */
  readonly name: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /** Bootstrap brokers. */
  readonly brokers: ReadonlyArray<string>;
}

export type KafkaIngestSource = Resource<
  "StarburstGalaxy.Ingest.KafkaIngestSource",
  KafkaIngestSourceProps,
  KafkaIngestSourceAttributes,
  never,
  Providers
>;

/** Galaxy accepted a source create but the source could not be read back. */
export class KafkaIngestSourceNotResolved extends Data.TaggedError(
  "StarburstGalaxy.KafkaIngestSourceNotResolved",
)<{ readonly sourceName: string }> {
  override get message() {
    return `Kafka ingest source ${this.sourceName} could not be found after it was created`;
  }
}

/**
 * A Kafka cluster Starburst Galaxy streams from: its brokers and how to
 * sign in. A `LiveTable` with Kafka-ingest properties loads one topic into
 * an Iceberg table.
 *
 * Name, description and credentials update in place; the brokers and the
 * region replace the source. The source itself reads nothing until a live
 * table uses it.
 *
 * Sources have no labels or tags in Galaxy: a source Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/data-ingest/configure-live-table-from-kafka.html
 *
 * ### Streaming from Confluent Cloud
 * **Example:** An API key as SASL/PLAIN credentials
 * ```typescript
 * const secret = yield* Config.Redacted("CONFLUENT_API_SECRET");
 * yield* StarburstGalaxy.Ingest.KafkaIngestSource("Clicks", {
 *   brokers: ["pkc-12345.us-east-1.aws.confluent.cloud:9092"],
 *   auth: { type: "saslPlain", username: "CONFLUENTAPIKEY", password: secret },
 *   cloudRegionId: "aws-us-east1",
 * });
 * ```
 *
 * @resource
 * @product Ingest
 */
export const KafkaIngestSource = Resource<KafkaIngestSource>(
  "StarburstGalaxy.Ingest.KafkaIngestSource",
);

const toAttributes = (source: KafkaIngestSourceShape): KafkaIngestSourceAttributes => ({
  kafkaIngestSourceId: source.kafkaIngestSourceId,
  name: source.name,
  description: source.description,
  brokers: source.kafkaBrokers,
});

const authOf = (auth: KafkaIngestAuth): KafkaAuth => {
  switch (auth.type) {
    case "saslPlain":
      return { authType: "saslPlainAuth", username: auth.username, password: auth.password };
    case "saslScram":
      return {
        authType: "saslScramAuth",
        username: auth.username,
        password: auth.password,
        scramType: auth.scramType,
      };
    case "iam":
      return { authType: "iamAuth", awsRoleArn: auth.awsRoleArn };
  }
};

/** Auth as plain values, for comparing two deploys. */
const comparable = (auth: KafkaIngestAuth) =>
  auth.type === "iam" ? auth : { ...auth, password: secretValue(auth.password) };

const getSource = (kafkaIngestSourceId: string) =>
  galaxy.kafkaIngestSource
    .getKafkaIngestSource({ kafkaIngestSourceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.kafkaIngestSource.listKafkaIngestSources.items({}), (s) => s.name === name);

const observe = Effect.fn(function* (kafkaIngestSourceId: string | undefined, name: string) {
  if (kafkaIngestSourceId !== undefined) {
    const byId = yield* getSource(kafkaIngestSourceId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const KafkaIngestSourceProvider = () =>
  Provider.succeed(KafkaIngestSource, {
    stables: ["kafkaIngestSourceId", "brokers"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (!deepEqual(news.brokers, olds.brokers) || news.cloudRegionId !== olds.cloudRegionId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, DATA_DOMAIN_NAME));
      const source = yield* observe(output?.kafkaIngestSourceId, name);
      if (source === undefined) return undefined;
      return ownership(toAttributes(source), {
        output,
        explicitName: olds?.name,
        previous,
        key: "kafkaIngestSourceId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
      const name = yield* physicalName(id, news.name, DATA_DOMAIN_NAME);

      // Observe
      let source = yield* observe(output?.kafkaIngestSourceId, name);

      // Ensure
      if (source === undefined) {
        yield* session.note(`Creating Kafka ingest source ${name}...`);
        const created = yield* galaxy.kafkaIngestSource
          .createKafkaIngestSource({
            name,
            description: news.description ?? "",
            kafkaBrokers: [...news.brokers],
            kafkaAuth: authOf(news.auth),
            cloudRegionId: news.cloudRegionId,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        source = created ?? (yield* findByName(name));
        if (source === undefined) {
          return yield* new KafkaIngestSourceNotResolved({ sourceName: name });
        }
        return toAttributes(source);
      }

      // Sync: name and description against Galaxy; write-only auth against
      // the last deploy, and always on adoption.
      const delta = changedFields(
        { ...source, description: source.description ?? "" },
        { name, description: news.description ?? "" },
      );
      const authChanged =
        olds === undefined || !deepEqual(comparable(olds.auth), comparable(news.auth));
      if (hasChanges(delta) || authChanged) {
        yield* session.note(`Updating Kafka ingest source ${name}...`);
        yield* galaxy.kafkaIngestSource.updateKafkaIngestSource({
          ...delta,
          ...(authChanged ? { kafkaAuth: authOf(news.auth) } : {}),
          kafkaIngestSourceId: source.kafkaIngestSourceId,
        });
        // The update answers with no body: read the source back.
        source = yield* galaxy.kafkaIngestSource.getKafkaIngestSource({
          kafkaIngestSourceId: source.kafkaIngestSourceId,
        });
      }
      return toAttributes(source);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.kafkaIngestSource
        .deleteKafkaIngestSource({ kafkaIngestSourceId: output.kafkaIngestSourceId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.kafkaIngestSource.listKafkaIngestSources
          .items({})
          .pipe(Stream.filter((source) => isGeneratedName(source.name))),
        toAttributes,
      ),
  });

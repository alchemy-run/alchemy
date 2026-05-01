import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AWSEnvironment } from "../Environment.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
import { toTagRecord, unwrapRedactedString } from "./common.ts";

export interface SAMLProviderProps {
  /**
   * The friendly SAML provider name.
   */
  name: string;
  /**
   * The provider metadata document.
   */
  samlMetadataDocument: string;
  /**
   * Optional assertion encryption mode.
   */
  assertionEncryptionMode?: iam.AssertionEncryptionModeType;
  /**
   * Optional private key added during creation/update.
   */
  addPrivateKey?: Redacted.Redacted<string> | string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface SAMLProvider extends Resource<
  "AWS.IAM.SAMLProvider",
  SAMLProviderProps,
  {
    samlProviderArn: string;
    name: string;
    samlProviderUUID: string | undefined;
    samlMetadataDocument: string | undefined;
    assertionEncryptionMode: iam.AssertionEncryptionModeType | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM SAML identity provider.
 *
 * `SAMLProvider` registers a SAML metadata document so IAM roles can trust an
 * external workforce or application identity provider.
 *
 * @section Federating with SAML
 * @example Create a SAML Identity Provider
 * ```typescript
 * const provider = yield* SAMLProvider("WorkforceSaml", {
 *   name: "workforce-saml",
 *   samlMetadataDocument: "<EntityDescriptor>...</EntityDescriptor>",
 * });
 * ```
 */
export const SAMLProvider = Resource<SAMLProvider>("AWS.IAM.SAMLProvider");

export const SAMLProviderProvider = () =>
  Provider.succeed(SAMLProvider, {
    stables: ["samlProviderArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.name !== news.name) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response) {
        return undefined;
      }
      const tags = yield* iam.listSAMLProviderTags({
        SAMLProviderArn: output.samlProviderArn,
      });
      return {
        samlProviderArn: output.samlProviderArn,
        name: output.name,
        samlProviderUUID: response.SAMLProviderUUID,
        samlMetadataDocument: response.SAMLMetadataDocument,
        assertionEncryptionMode: response.AssertionEncryptionMode,
        tags: toTagRecord(tags.Tags),
      };
    }),
    create: Effect.fn(function* ({ id, news, session }) {
      const internalTags = yield* createInternalTags(id);
      const tags = {
        ...internalTags,
        ...news.tags,
      };
      const response = yield* iam
        .createSAMLProvider({
          Name: news.name,
          SAMLMetadataDocument: news.samlMetadataDocument,
          AssertionEncryptionMode: news.assertionEncryptionMode,
          AddPrivateKey: news.addPrivateKey
            ? unwrapRedactedString(news.addPrivateKey)
            : undefined,
          Tags: Object.entries(tags).map(([Key, Value]) => ({
            Key,
            Value,
          })),
        })
        .pipe(
          Effect.catchTag("EntityAlreadyExistsException", () =>
            Effect.gen(function* () {
              const accountId = (yield* AWSEnvironment).accountId;
              const existingArn = `arn:aws:iam::${accountId}:saml-provider/${news.name}`;
              const existingTags = yield* iam.listSAMLProviderTags({
                SAMLProviderArn: existingArn,
              });
              if (!hasTags(internalTags, existingTags.Tags)) {
                return yield* Effect.fail(
                  new Error(
                    `SAML provider '${news.name}' already exists and is not managed by alchemy`,
                  ),
                );
              }
              return { SAMLProviderArn: existingArn };
            }),
          ),
        );
      const samlProviderArn = response.SAMLProviderArn ?? news.name;
      yield* session.note(samlProviderArn);
      return {
        samlProviderArn,
        name: news.name,
        samlProviderUUID: undefined,
        samlMetadataDocument: news.samlMetadataDocument,
        assertionEncryptionMode: news.assertionEncryptionMode,
        tags,
      };
    }),
    update: Effect.fn(function* ({ id, news, olds, output, session }) {
      yield* iam.updateSAMLProvider({
        SAMLProviderArn: output.samlProviderArn,
        SAMLMetadataDocument:
          news.samlMetadataDocument !== olds.samlMetadataDocument
            ? news.samlMetadataDocument
            : undefined,
        AssertionEncryptionMode: news.assertionEncryptionMode,
        AddPrivateKey: news.addPrivateKey
          ? unwrapRedactedString(news.addPrivateKey)
          : undefined,
      });
      const internalTags = yield* createInternalTags(id);
      const oldTags = { ...internalTags, ...(olds.tags ?? {}) };
      const newTags = { ...internalTags, ...(news.tags ?? {}) };
      const { removed, upsert } = diffTags(oldTags, newTags);
      if (upsert.length > 0) {
        yield* iam.tagSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
          Tags: upsert,
        });
      }
      if (removed.length > 0) {
        yield* iam.untagSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
          TagKeys: removed,
        });
      }
      yield* session.note(output.samlProviderArn);
      return {
        samlProviderArn: output.samlProviderArn,
        name: output.name,
        samlProviderUUID: output.samlProviderUUID,
        samlMetadataDocument: news.samlMetadataDocument,
        assertionEncryptionMode: news.assertionEncryptionMode,
        tags: newTags,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });

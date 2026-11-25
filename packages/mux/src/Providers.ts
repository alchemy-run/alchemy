import * as MuxRetry from "@distilled.cloud/mux/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { MuxAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { Annotation, AnnotationProvider } from "./Data/Annotation.ts";
import { Directive, DirectiveProvider } from "./Robots/Directive.ts";
import { SigningKey, SigningKeyProvider } from "./System/SigningKey.ts";
import { Webhook, WebhookProvider } from "./System/Webhook.ts";
import { Asset, AssetProvider } from "./Video/Asset.ts";
import { LiveStream, LiveStreamProvider } from "./Video/LiveStream.ts";
import { PlaybackRestriction, PlaybackRestrictionProvider } from "./Video/PlaybackRestriction.ts";
import { SimulcastTarget, SimulcastTargetProvider } from "./Video/SimulcastTarget.ts";
import {
  TranscriptionVocabulary,
  TranscriptionVocabularyProvider,
} from "./Video/TranscriptionVocabulary.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Mux") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Mux providers and credentials. Registers the Mux AuthProvider so
 * `alchemy profile edit` can configure an access token.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Webhook,
      Asset,
      LiveStream,
      SimulcastTarget,
      SigningKey,
      PlaybackRestriction,
      TranscriptionVocabulary,
      Annotation,
      Directive,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        WebhookProvider(),
        AssetProvider(),
        LiveStreamProvider(),
        SimulcastTargetProvider(),
        SigningKeyProvider(),
        PlaybackRestrictionProvider(),
        TranscriptionVocabularyProvider(),
        AnnotationProvider(),
        DirectiveProvider(),
      ),
    ),
    Layer.provideMerge(Layer.succeed(MuxRetry.Retry, DeployRetry.policy)),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(MuxAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );

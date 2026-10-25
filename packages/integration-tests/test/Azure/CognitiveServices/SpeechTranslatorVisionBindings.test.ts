import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as uv from "@distilled.cloud/azure/cognitiveservices-unified-vision";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import SpeechTranslatorVisionFunction, {
  LANDMARK_JPG,
  Speech,
  Translator,
  Vision,
  WEATHER_WAV,
} from "./fixtures/speech-translator-vision-function.ts";
import { waitGone } from "./util.ts";

const {
  test: baseTest,
  beforeAll,
  afterAll,
  deploy,
  destroy,
} = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Cognitive Services User**: the deployer's out-of-band data-plane access. */
const COGNITIVE_SERVICES_USER = "a97b65f3-24c7-4388-baec-2e87135dc908";

/** Display name of the batch transcription the Speech bindings create, read, and delete. */
const TRANSCRIPTION = "alchemy-stv-bindings";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureSpeechTranslatorVisionBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SpeechTranslatorVisionFunction;
    const translator = yield* Translator;
    const speech = yield* Speech;
    const vision = yield* Vision;
    // Lets the deployer call the data planes out of band.
    const deployer = yield* callerObjectId;
    for (const [id, account] of [
      ["StvDeployerTranslator", translator],
      ["StvDeployerSpeech", speech],
      ["StvDeployerVision", vision],
    ] as const) {
      yield* Azure.Authorization.RoleAssignment(id, {
        scope: account.accountId,
        roleDefinitionId: COGNITIVE_SERVICES_USER,
        principalId: deployer,
      });
    }
    return {
      url: fn.url,
      principalId: fn.principalId,
      resourceGroup: translator.resourceGroup,
      accounts: {
        translator: {
          id: translator.accountId,
          name: translator.accountName,
          subdomain: translator.customSubDomainName,
        },
        speech: {
          id: speech.accountId,
          name: speech.accountName,
          subdomain: speech.customSubDomainName,
        },
        vision: {
          id: vision.accountId,
          name: vision.accountName,
          subdomain: vision.customSubDomainName,
        },
      },
    };
  }),
);

// Pay-per-call Translator, Speech, and Vision accounts (a few translations,
// three short transcriptions, two embeddings: < $0.05) + Flex Consumption;
// ~6 min deploy. Entra data-plane grants take 5-20 min to apply.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const live = { timeout: 1_800_000 };

/** A test whose body also gets the deployer's Azure credentials for out-of-band checks. */
const test = <A, E>(name: string, body: Effect.Effect<A, E, any>, options = live) =>
  baseTest(name, body.pipe(Effect.provide(azure)), options);

/** An account's custom-subdomain endpoint: Entra tokens work only there. */
const endpointOf = (account: "translator" | "speech" | "vision", path = "") =>
  Effect.map(
    stack,
    (outputs) =>
      `https://${outputs.accounts[account].subdomain}.cognitiveservices.azure.com${path}`,
  );
const translator = endpointOf("translator", "/translator/text/v3.0");
const speechEndpoint = endpointOf("speech");
const vision = endpointOf("vision", "/computervision");

type Body = { ok: boolean; result?: any; error?: string };

/** POST the binding's request to `/<binding>` once. */
const post = (binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/${binding}`).pipe(HttpClientRequest.bodyJsonUnsafe(request)),
    ).pipe(Effect.timeout("90 seconds"));
    return (yield* response.json) as Body;
  });

/**
 * Call a binding until it answers `ok`, through the Flex Consumption cold
 * start and role propagation (AI services apply a new data-plane grant
 * per operation, 5-20 min after the assignment), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (binding: string, request: unknown = {}) =>
  post(binding, request).pipe(
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 150 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

/** Retry a deployer data-plane call while the deployer's own grant propagates. */
const asDeployer = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Unauthorized",
      schedule: Schedule.spaced("10 seconds"),
      times: 120,
    }),
  );

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Cosine similarity of two vectors. */
const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
  const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return dot / (norm(a) * norm(b));
};

/** The transcription ID at the end of its `self` URL. */
const transcriptionIdOf = (self: string | undefined) =>
  (self ?? "").split("/").pop()?.split("?")[0] ?? "";

/** Every role on the Function's identity as `<data actions> <scope>`, plus the custom role IDs. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const grants: string[] = [];
    const customRoles: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      // The Function's own host-storage grants.
      if (/\/storageaccounts\/[^/]+$/.test(scope)) continue;
      const roleDefinitionId = assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId,
      });
      if (definition.properties?.type === "CustomRole") customRoles.push(roleDefinitionId);
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.CognitiveServices/accounts/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return { grants: grants.sort(), customRoles };
  });

describe(
  "Azure AI Speech, Translator, and Vision bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:cognitiveservices", "live"] },
  () => {
    test(
      "assigns each binding its own data action on the account only",
      Effect.gen(function* () {
        const { principalId, accounts } = yield* stack;
        // The first call waits out the cold start, so every role is assigned.
        expectOk(yield* call("TranslateText", { to: ["de"], body: [{ text: "Hi" }] }));
        // A filtered assignment list trails new assignments by seconds.
        const { grants } = yield* grantsOf(principalId!).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: ({ grants }) => grants.length >= 14,
            times: 24,
          }),
        );
        const on = (account: keyof typeof accounts, actions: string[]) =>
          actions.map((action) => `${action} ${accounts[account].id.toLowerCase()}`);
        expect(grants).toEqual(
          [
            ...on("vision", [
              "ComputerVision/retrieval:vectorizeimage/action",
              "ComputerVision/retrieval:vectorizetext/action",
            ]),
            ...on("speech", [
              "SpeechServices/speechrest/transcriptions/action",
              "SpeechServices/speechrest/transcriptions/delete",
              "SpeechServices/speechrest/transcriptions/files/read",
              "SpeechServices/speechrest/transcriptions/read",
              "SpeechServices/speechrest/transcriptions/write",
            ]),
            ...on("translator", [
              "TextTranslation/breaksentence/action",
              "TextTranslation/detect/action",
              "TextTranslation/dictionary/examples/action",
              "TextTranslation/dictionary/lookup/action",
              "TextTranslation/languages/read",
              "TextTranslation/translate/action",
              "TextTranslation/transliterate/action",
            ]),
          ].sort(),
        );
      }),
    );

    describe("TranslateText", () => {
      test(
        "translates text the way the deployer's own call does",
        Effect.gen(function* () {
          const request = { from: "en", to: ["de"], body: [{ text: "Good morning" }] };
          const body = yield* call("TranslateText", request);
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(tt.TranslatorTranslate({ ...request, endpoint }));
          expect(body.result[0].translations[0].to).toEqual("de");
          expect(body.result[0].translations[0].text).toEqual(expected[0]!.translations![0]!.text);
          expect(body.result[0].translations[0].text.toLowerCase()).toContain("guten morgen");
        }),
      );
    });

    describe("TransliterateText", () => {
      test(
        "converts Japanese script to Latin script",
        Effect.gen(function* () {
          const request = {
            language: "ja",
            fromScript: "Jpan",
            toScript: "Latn",
            body: [{ text: "こんにちは" }],
          };
          const body = yield* call("TransliterateText", request);
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(tt.TranslatorTransliterate({ ...request, endpoint }));
          expect(body.result).toEqual(expected);
          expect(body.result[0].script).toEqual("Latn");
        }),
      );
    });

    describe("DetectTextLanguage", () => {
      test(
        "detects French",
        Effect.gen(function* () {
          const request = { body: [{ text: "Bonjour tout le monde, comment allez-vous ?" }] };
          const body = yield* call("DetectTextLanguage", request);
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(tt.TranslatorDetect({ ...request, endpoint }));
          expect(body.result[0].language).toEqual("fr");
          expect(expected[0]!.language).toEqual("fr");
          expect(body.result[0].isTranslationSupported).toEqual(true);
        }),
      );
    });

    describe("BreakSentences", () => {
      test(
        "finds three sentences",
        Effect.gen(function* () {
          const request = {
            Language: "en",
            body: [{ text: "How are you? I am fine. What did you do today?" }],
          };
          const body = yield* call("BreakSentences", request);
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(tt.TranslatorBreakSentence({ ...request, endpoint }));
          expect(body.result[0].sentLen).toEqual(expected[0]!.sentLen);
          expect(body.result[0].sentLen).toHaveLength(3);
        }),
      );
    });

    describe("LookupDictionary", () => {
      test(
        "returns Spanish translations of a word",
        Effect.gen(function* () {
          const request = { from: "en", to: "es", body: [{ text: "fly" }] };
          const body = yield* call("LookupDictionary", request);
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(
            tt.LookupTranslatorDictionary({ ...request, endpoint }),
          );
          const targets = (body.result[0].translations as { normalizedTarget: string }[]).map(
            (t) => t.normalizedTarget,
          );
          expect(targets).toEqual(expected[0]!.translations!.map((t) => t.normalizedTarget));
          expect(targets).toContain("volar");
        }),
      );
    });

    describe("LookupDictionaryExamples", () => {
      test(
        "returns example sentences for a translation pair",
        Effect.gen(function* () {
          const request = { from: "en", to: "es", body: [{ text: "fly", translation: "volar" }] };
          const body = yield* call("LookupDictionaryExamples", request);
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(
            tt.TranslatorDictionaryExamples({ ...request, endpoint }),
          );
          expect(body.result[0].examples.length).toEqual(expected[0]!.examples!.length);
          expect(body.result[0].examples[0].targetTerm).toEqual("volar");
        }),
      );
    });

    describe("ListTranslatorLanguages", () => {
      test(
        "lists translation languages keyed by code",
        Effect.gen(function* () {
          const body = yield* call("ListTranslatorLanguages", { scope: ["translation"] });
          expectOk(body);
          const endpoint = yield* translator;
          const expected = yield* asDeployer(
            tt.TranslatorLanguages({ endpoint, scope: ["translation"] }),
          );
          expect(body.result.translation.de.name).toEqual("German");
          expect(Object.keys(body.result.translation).sort()).toEqual(
            Object.keys(expected.translation ?? {}).sort(),
          );
          expect(body.result.dictionary).toBeUndefined();
        }),
      );
    });

    describe("TranscribeAudio", () => {
      test(
        "transcribes audio at a URL",
        Effect.gen(function* () {
          const body = yield* call("TranscribeAudio", {
            definition: { locales: ["en-US"], audioUrl: WEATHER_WAV },
          });
          expectOk(body);
          expect(body.result.combinedPhrases[0].text.toLowerCase()).toContain("weather");
        }),
      );

      test(
        "transcribes uploaded audio bytes",
        Effect.gen(function* () {
          const body = yield* call("TranscribeAudioFile", { url: WEATHER_WAV, locales: ["en-US"] });
          expectOk(body);
          expect(body.result.combinedPhrases[0].text.toLowerCase()).toContain("weather");
          expect(body.result.durationMilliseconds).toBeGreaterThan(1000);
        }),
      );
    });

    // One batch transcription walks submit -> get -> list files -> delete.
    describe("SubmitTranscription", () => {
      test(
        "submits, reads, lists, and deletes a batch transcription",
        Effect.gen(function* () {
          const endpoint = yield* speechEndpoint;
          const submitted = yield* call("SubmitTranscription", {
            displayName: TRANSCRIPTION,
            locale: "en-US",
            contentUrls: [WEATHER_WAV],
            properties: { timeToLiveHours: 6 },
          });
          expectOk(submitted);
          const id = transcriptionIdOf(submitted.result.self);
          expect(id).toMatch(/^[0-9a-f-]{36}$/);

          // Out of band: the deployer sees it, and it finishes.
          const done = yield* asDeployer(stt.GetTranscription({ endpoint, id })).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (t) => t.status === "Succeeded" || t.status === "Failed",
              times: 60,
            }),
          );
          expect({ displayName: done.displayName, status: done.status }).toEqual({
            displayName: TRANSCRIPTION,
            status: "Succeeded",
          });

          // GetTranscription
          const read = yield* call("GetTranscription", { id });
          expectOk(read);
          expect({ displayName: read.result.displayName, status: read.result.status }).toEqual({
            displayName: TRANSCRIPTION,
            status: "Succeeded",
          });

          // ListTranscriptionFiles
          const files = yield* call("ListTranscriptionFiles", { id });
          expectOk(files);
          const kinds = (files.result.values as { kind: string }[]).map((f) => f.kind).sort();
          expect(kinds).toEqual(["Transcription", "TranscriptionReport"]);

          // DeleteTranscription
          expectOk(yield* call("DeleteTranscription", { id }));
          expect(yield* waitGone(stt.GetTranscription({ endpoint, id }))).toEqual("gone");
        }),
      );
    });

    describe("VectorizeImage", () => {
      test(
        "embeds an image like the deployer's own call",
        Effect.gen(function* () {
          const request = { model_version: "2023-04-15", url: LANDMARK_JPG };
          const body = yield* call("VectorizeImage", request);
          expectOk(body);
          const endpoint = yield* vision;
          const expected = yield* asDeployer(uv.VectorizeImage({ ...request, endpoint }));
          expect(body.result.vector).toHaveLength(1024);
          expect(body.result.modelVersion).toEqual(expected.modelVersion);
          // Embeddings vary in the last digits between calls.
          expect(cosine(body.result.vector, expected.vector!)).toBeGreaterThan(0.99);
        }),
      );
    });

    describe("VectorizeText", () => {
      test(
        "embeds text like the deployer's own call",
        Effect.gen(function* () {
          const request = { model_version: "2023-04-15", text: "a castle on a hill" };
          const body = yield* call("VectorizeText", request);
          expectOk(body);
          const endpoint = yield* vision;
          const expected = yield* asDeployer(uv.VectorizeText({ ...request, endpoint }));
          expect(body.result.vector).toHaveLength(1024);
          // Embeddings vary in the last digits between calls.
          expect(cosine(body.result.vector, expected.vector!)).toBeGreaterThan(0.99);
        }),
      );
    });
  },
);

// Destroy, then prove every role on the Function's identity, every custom
// role the bindings created, and the account are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `stack` is undefined when the deploy failed; destroy what it left anyway.
    const outputs = yield* stack;
    if (outputs === undefined) return yield* destroy(Stack);
    const principalId = outputs.principalId!;
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const { customRoles } = yield* grantsOf(principalId);
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const remaining = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(
        Effect.map((page) => page.value.length),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (n) => n === 0,
          times: 12,
        }),
      );
    expect(remaining).toEqual(0);
    // The transcriptions live in the Speech account: deleting it deletes them.
    for (const account of Object.values(outputs.accounts)) {
      const status = yield* waitGone(
        cognitiveservices.GetAccount({
          subscriptionId,
          resourceGroupName: outputs.resourceGroup,
          accountName: account.name,
        }),
      );
      expect({ account: account.name, status }).toEqual({ account: account.name, status: "gone" });
    }
    for (const roleDefinitionId of new Set(customRoles)) {
      const gone = yield* authorization
        .GetRoleDefinition({ scope: `/subscriptions/${subscriptionId}`, roleDefinitionId })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status) => status === "gone",
            times: 12,
          }),
        );
      expect({ roleDefinitionId, gone }).toEqual({ roleDefinitionId, gone: "gone" });
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);

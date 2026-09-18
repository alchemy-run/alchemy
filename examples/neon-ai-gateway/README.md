# Neon AI Gateway

A native streaming chat page and an Effect-native API. The native Function uses
`@neon/ai-sdk-provider` and the Vercel AI SDK. The Effect Function uses
a bound `Neon.QueryAIGateway` client's `.model(...)` with
`effect/unstable/ai/LanguageModel`,
not an SDK call wrapped in an Effect. The stack creates its own Neon project,
branch, and two Functions. It does not buy credits or upgrade an account.

## Deploy without inference

Use Node.js 24+, installed workspace dependencies, and an Alchemy `testing`
profile with Neon backend access in `aws-us-east-2`. An exported `NEON_API_KEY`
overrides profile credentials; unset it if you intend to use only the profile.
Cloud infrastructure can still incur charges even when inference is disabled.

Create a private, gitignored `.env` in this directory:

```dotenv
NEON_EXAMPLE_API_KEY=<a long random application secret>
NEON_AI_MODEL=gpt-5-mini
NEON_AI_ALLOW_PAID=false
```

Use a model ID supported by your branch, not an assumed `openai/`-prefixed name.
The example key authenticates **this demo only**; it is not your Neon account key
or the branch gateway token. Gateway credentials stay on the server. The Effect
Function keeps deployment and runtime configuration names aligned.

```sh
timeout 240 pnpm --config.verify-deps-before-run=false exec alchemy deploy --stage ai-demo --profile testing --yes
```

Open the printed `url`. Enter your **example** key and click **Send**. With the
configuration above, a valid prompt returns **503: paid inference disabled**.
The page does not persist the entered key across reloads.

## API checks

Send JSON `{ "prompt": "Hello" }` to `POST /chat` on either `url` or
`effectApiUrl`, with `Authorization: Bearer <example key>`.

| Request | Expected status |
| --- | --- |
| Missing or wrong example key | 401 |
| Authenticated malformed JSON, missing/non-string prompt, blank prompt, or more than 4000 characters | 400 |
| Authenticated valid prompt with paid inference disabled | 503 |

Authentication runs before validation; validation runs before the paid gate, so
all negative checks are safe without inference. The native Function serves the
public page at `/`; unknown native routes return 404. The Effect URL is an API,
not a second chat page. Never expose the account key in either request.

## Effect AI API

Bind the branch gateway during Function initialization, then provide its model
inside a request handler:

```typescript
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";

const ai = yield* Neon.QueryAIGateway(gateway);
const model = ai.model({
  model: "gpt-5-mini",
  parameters: { maxTokens: 128 },
});

// Inside an authenticated, explicitly opted-in request:
const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
  Effect.provide(model),
);
```

`src/EffectApi.ts` uses `LanguageModel.streamText({ prompt })` instead, provides
that same model, and encodes its text parts with Effect's `Stream` and `Sse`
modules. It captures the request's runtime context and scope before returning
`HttpServerResponse.stream`, so deferred body consumption retains the bound
services. Request aborts interrupt the stream, and model failures become a fixed,
credential-free SSE error message.

Both APIs emit the browser's existing `text-delta` / `error` SSE events and a
`[DONE]` terminator on normal completion. The Effect route also emits the UI
message start/text-end/finish events and the `x-vercel-ai-ui-message-stream: v1`
header. The native UI and `src/native.ts` remain the Vercel SDK variant.

The Effect model uses Neon's OpenAI-compatible `/v1/chat/completions` endpoint,
including for Claude models. Responses-only models and native Anthropic
thinking/cache controls require their respective SDK routes, not this adapter.
Tool calls and `LanguageModel.generateObject` are available through the Effect
adapter when the selected model supports them; this example streams text only.

## Optional paid streaming

Only after you independently approve spending and confirm an existing entitled
account, prepaid credits, and an available model should you explicitly set
`NEON_AI_ALLOW_PAID=true` and redeploy. Do not enable it merely to test the demo.
The code limits responses to 128 output tokens and disables automatic retries.
**Cancel** aborts the browser request; actual upstream cancellation and billing
behavior require a permitted live inference run to verify.

## Browser verification (September 17, 2026)

After the Effect LanguageModel rewrite, the ordinary example stack was freshly
deployed as `browser-effect-model-0917` with `--profile testing`, the inherited
`NEON_API_KEY` unset, and `NEON_AI_ALLOW_PAID=false` throughout. Installed Chromium
and Playwright exercised the deployed handlers at desktop **1440×1000** and
mobile **390×844** viewport sizes.

- Empty key/prompt fields prevented submission without an HTTP request.
- Both live handlers returned **401** for missing/wrong authentication; **400**
  for malformed JSON, missing/null/non-string/blank/oversized prompt payloads;
  and **503** for valid authenticated prompts with paid inference disabled.
- The forms rendered the real 401/400/503 responses. Responses exposed neither
  the disposable example key nor gateway-token/stack-trace details.
- Native→Effect→native checks passed at both viewport sizes. Reload cleared the
  key and restored the ready state; controls remained usable and neither layout
  overflowed horizontally. Cancel was clicked with no active inference; this
  does not verify upstream cancellation.

The native UI has no built-in API selector. For Effect rendering checks, the
browser harness forwarded `/chat` to the live Effect URL and returned its real
status/body unchanged. Separate **same-origin browser requests** verified the
nine-case API matrix directly against each Function. No response was fabricated;
these checks do not establish cross-origin application switching. The native UI
source and controls were not changed.

Local, gitignored evidence is in
`.alchemy/browser-evidence/language-model-live/`: `verification.json`,
`desktop-native.png`, `desktop-effect.png`, `mobile-native.png`,
`mobile-effect.png`, `cleanup.json`, and lifecycle logs. The report includes
deployed URLs and source hashes. One normal destroy removed all four resources;
subsequent browser navigations to both Function URLs returned **404**. The
private disposable `.env` was removed after cleanup, and saved evidence was
checked for the example secret. No source fix or redeployment was needed.

Offline handler/protocol tests separately cover actual
LanguageModel wiring, deferred request context, SSE encoding/error sanitization,
and cancellation using a mock model.

A separately authorized minimal live inference probe returned **403: `ai gateway
not enabled for account`**. Successful paid inference, real streamed model output,
and upstream cancellation/billing remain unverified. No credits were purchased,
no account was upgraded, and no inference probe was repeated for this browser run.
Function updates have had upstream stale-runtime reports; this check used a fresh
stack rather than an update/redeployment workaround.

## Destroy

Keep `.env` and local `.alchemy` state until normal cleanup finishes, and use the
same directory, profile, and stage:

```sh
timeout 240 pnpm --config.verify-deps-before-run=false exec alchemy destroy --stage ai-demo --profile testing --yes
```

Then remove the disposable example key. Do not directly delete cloud resources
or erase stack state to bypass a cleanup failure.

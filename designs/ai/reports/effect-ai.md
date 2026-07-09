# effect v4 unstable AI — API reference & gap analysis for the Alchemy AI Kernel

> Subject: `node_modules/effect/dist/unstable/ai/` (effect v4, `@since 4.0.0`, unstable) plus the
> provider packages `@effect/ai-anthropic` and `@effect/ai-openai` (v4.0.0-beta.75, resolved under
> `node_modules/.bun/node_modules/@effect/`). Everything below is verified against the shipped
> `.d.ts` files, with `.js` implementations read wherever the types alone are ambiguous. File:line
> citations refer to those dist files.

---

## 1. Module map

| Module | Role (one line) |
|---|---|
| `LanguageModel` | The provider-agnostic model service: `generateText` / `streamText` / `generateObject`, one model round each, with optional toolkit-driven tool-call resolution. |
| `Tool` | Tool definitions: `make` (static schema), `dynamic` (runtime schema / raw JSON Schema), `providerDefined` (provider-builtin); approval, failure mode, annotations, JSON-schema derivation. |
| `Toolkit` | A named collection of Tools that is itself an `Effect` yielding `WithHandler` (tools + a `handle(name, params)` executor); handlers attach via `.toLayer` / `.toHandlers` / by yielding the toolkit. |
| `Prompt` | The message/content model (system/user/assistant/tool messages; text/file/reasoning/tool-call/tool-result/approval parts), fully Schema-codec'd and serializable, with per-message/per-part `options` for provider-specific data (e.g. Anthropic cache breakpoints). |
| `Response` | The response part model: final `Part`s and streaming `StreamPart`s (text/reasoning deltas, tool params streaming, tool calls/results, approval requests, sources, response-metadata, finish+usage, error). |
| `Chat` | A stateful conversation service over `LanguageModel`: history in a `Ref<Prompt>`, auto-append semantics, `export`/`exportJson`/`fromExport` round-trip, plus `Persistence`/`layerPersisted` over `BackingPersistence`. |
| `Model` | Wraps a provider Layer with `provider`/`model` metadata (`ProviderName`, `ModelName` tags); a `Model` IS a `Layer` and also an Effect that can capture its requirements. |
| `AiError` | One wrapper error class (`AiError`) with a closed union of 18 typed `reason`s; `isRetryable`/`retryAfter` getters; `Effect.catchReason`-compatible. |
| `Telemetry` | OpenTelemetry `gen_ai.*` semantic-convention attributes + `CurrentSpanTransformer` service for annotating model spans. |
| `Tokenizer` | A service interface (`tokenize`, `truncate`) — implementation is per-provider/per-model, supplied by you or a provider package. |
| `IdGenerator` | Service minting ids for tool calls / approval ids; `defaultIdGenerator` + `make({alphabet, prefix, separator, size})`. |
| `ResponseIdTracker` | Mutable service enabling incremental provider calls (`previousResponseId` + suffix prompt) for providers with server-side conversation state (OpenAI Responses API). |
| `McpServer` / `McpSchema` | Expose Toolkits/resources/prompts as an MCP server (stdio or HTTP); `McpSchema` is the full MCP protocol schema. |
| `AnthropicStructuredOutput` / `OpenAiStructuredOutput` | `CodecTransformer`s that rewrite Effect Schemas into each provider's supported JSON-Schema subset for structured output / strict tools. |
| `EmbeddingModel` | Embedding service (make + batching); not load-bearing for the kernel, noted for completeness. |
| `@effect/ai-anthropic` | `AnthropicClient` (HttpClient-based Messages API client) + `AnthropicLanguageModel` (`model`/`make`/`layer`, `Config` service, cache_control support, provider metadata augmentations). |
| `@effect/ai-openai` | `OpenAiClient` (+ `layerWebSocketMode` which provides `ResponseIdTracker`) + `OpenAiLanguageModel` over the **Responses API** (`previous_response_id`, `store`, reasoning config). |

The public namespace map is `effect/dist/unstable/ai/index.d.ts:7-71` — `AiError`,
`AnthropicStructuredOutput`, `Chat`, `EmbeddingModel`, `IdGenerator`, `LanguageModel`, `McpSchema`,
`McpServer`, `Model`, `OpenAiStructuredOutput`, `Prompt`, `Response`, `ResponseIdTracker`,
`Telemetry`, `Tokenizer`, `Tool`, `Toolkit`.

---

## 2. LanguageModel

### Service shape

`LanguageModel` is a `Context.Service` class (`LanguageModel.d.ts:41`) whose `Service` interface
(`LanguageModel.d.ts:49-86`) has exactly three members. All three are heavily overloaded on the
`toolkit` option so tool types flow into the response type:

```ts
// LanguageModel.d.ts:53-65 (module-level accessor at 518-530 adds `LanguageModel` to R)
generateText: <Options>(options: Options & GenerateTextOptions<Tools>)
  => Effect<GenerateTextResponse<Tools>, ExtractError<Options>, ExtractServices<Options>>

// LanguageModel.d.ts:73-85 (accessor at 592-604)
streamText: (options) => Stream<Response.StreamPart<Tools>, ExtractError<Options>, ExtractServices<Options>>

// LanguageModel.d.ts:69 (accessor at 564)
generateObject: <ObjectEncoded, StructuredOutputSchema, Options, Tools = {}>(options)
  => Effect<GenerateObjectResponse<Tools, Schema["Type"]>, ExtractError<Options>,
            ExtractServices<Options> | Schema["DecodingServices"]>
```

### GenerateTextOptions (`LanguageModel.d.ts:131-173`)

| Field | Type | Notes |
|---|---|---|
| `prompt` | `Prompt.RawInput` | string \| `Iterable<MessageEncoded>` \| `Prompt` (`Prompt.d.ts:1330`). |
| `toolkit?` | `ToolkitInput<Tools>` | a `Toolkit.WithHandler<Tools>` **or an `Effect` producing one** (`LanguageModel.d.ts:318-331`) — the Effect form is how a `Toolkit` (which is itself an Effect requiring handlers) is passed directly. |
| `toolChoice?` | `"auto" \| "none" \| "required" \| { tool: Name } \| { mode?: "auto"\|"required", oneOf: Name[] }` | `LanguageModel.d.ts:212-217`. The `oneOf` subset filters which tools are *sent to the provider* (`LanguageModel.js:489`, `:662`). |
| `concurrency?` | `Concurrency` | concurrency for resolving tool calls (`LanguageModel.d.ts:162`; applied at `LanguageModel.js:1086-1089`). |
| `disableToolCallResolution?` | `boolean` | tools are still *advertised* to the model, but handlers are NOT executed; the raw `tool-call` parts come back to you (`LanguageModel.d.ts:164-172`, `LanguageModel.js:503-513`, `:674-685`). With `true`, `ExtractError` drops `Tool.HandlerError` and `ExtractServices` is `never` (`LanguageModel.d.ts:355-377`). |

`GenerateObjectOptions` extends this with `schema` (required) and `objectName?`
(`LanguageModel.d.ts:183-193`).

### GenerateTextResponse (`LanguageModel.d.ts:243-274`)

Wraps `content: Array<Response.Part<Tools>>` with getters: `text` (concat of text parts),
`reasoning` / `reasoningText`, `toolCalls` (typed `Response.ToolCallParts<Tools>`), `toolResults`,
`finishReason` (from the `finish` part; `"unknown"` if absent — `LanguageModel.js:148-151`), and
`usage`. **Usage carries cache splits**: `Response.Usage` (`Response.d.ts:1655-1708`) is

```ts
inputTokens:  { uncached?: number, total?: number, cacheRead?: number, cacheWrite?: number }  // all | undefined
outputTokens: { total?: number, text?: number, reasoning?: number }                           // all | undefined
```

— exactly the AI-SDK-v4-style "every count possibly absent" shape §2.4 assumes. `finishReason` is
the **unified** enum `"stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" |
"other" | "unknown"` (`Response.d.ts:1632-1641`); raw provider finish data lands in the finish
part's provider `metadata` (e.g. Anthropic `stopSequence`/`usage` at
`AnthropicLanguageModel.d.ts:656-663`).

### One round, not a loop — verified in the implementation

`generateText` (`LanguageModel.js:369-526`, `generateContent`) makes **exactly one provider call**.
Sequence: (1) collect pending tool approvals from the prompt and pre-execute approved / synthesize
denied results *before* the call (`LanguageModel.js:456-477`), appending them as a `tool` message;
(2) strip resolved approval artifacts (`:480-488`); (3) one `params.generateText(...)` provider call
(`:514`); (4) run `resolveToolCalls` over the returned `tool-call` parts — executing handlers via
`toolkit.handle` with the configured concurrency (`:516`, `:1023-1090`); (5) return
`[...content, ...toolResults]` (`:525`). **Tool results are never fed back to the model; nothing
drives continuation.** The multi-turn loop is entirely the caller's job (for `Chat`, the next
`generateText` call sends the appended history).

`streamText` (`LanguageModel.js:527-760`) is the same single round in streaming form: one provider
stream; each decoded `tool-call` part forks a handler fiber into a `FiberSet`
(`:747-751`, `handleToolCall` at `:700-723`); `finish` parts are **deferred until all tool handlers
complete** so tool-results always precede finish in the output stream (`:733-745`, `:756`); then the
queue ends. If a tool needs approval, a `tool-approval-request` part is emitted **instead of**
executing the handler (`:703-713`). Again: no second model round.

### Provider adapter contract

`LanguageModel.make` (`LanguageModel.d.ts:478-492`) builds the service from two provider hooks:

```ts
make: (params: {
  generateText: (options: ProviderOptions) => Effect<Array<Response.PartEncoded>, AiError, IdGenerator>
  streamText:   (options: ProviderOptions) => Stream<Response.StreamPartEncoded, AiError, IdGenerator>
  codecTransformer?: CodecTransformer
}) => Effect<Service>
```

`ProviderOptions` (`LanguageModel.d.ts:390-445`) is the normalized request: `prompt: Prompt.Prompt`,
`tools: ReadonlyArray<Tool.Any>`, `responseFormat: {type:"text"} | {type:"json", objectName, schema}`,
`toolChoice`, `span: Span`, `previousResponseId: string | undefined`, `incrementalPrompt:
Prompt.Prompt | undefined` (the last two fed by `ResponseIdTracker` when present —
`LanguageModel.js:370`, `:492-498`; falls back to the full prompt on `InvalidRequestError`,
`:372-384`).

`generateObject` routes through the `generateText` hook with `responseFormat: {type:"json"}` and
decodes the concatenated text through `Schema.fromJsonString(schema)`
(`LanguageModel.js:280-326`, `:1109-1133`); provider-incompatible schemas are rewritten by the
configured `codecTransformer` (default `defaultCodecTransformer`, `LanguageModel.d.ts:124`).

---

## 3. Tool

### Constructors

**`Tool.make`** (`Tool.d.ts:810-860`):

```ts
Tool.make(name, {
  description?: string
  parameters?: Schema.Constraint          // default EmptyParams = Record<String, Never> (Tool.d.ts:1388-1407)
  success?: Schema.Constraint             // default Schema.Void
  failure?: Schema.Constraint             // default Schema.Never
  failureMode?: "error" | "return"        // default "error"  (Tool.d.ts:96)
  dependencies?: Array<Context.Key<any, any>>   // ← lands in the Tool's Requirements
  needsApproval?: boolean | (params, {toolCallId, messages}) => boolean | Effect<boolean>
}) => Tool<Name, {parameters, success, failure, failureMode}, Context.Service.Identifier<Deps[number]>>
```

- **`dependencies`** (`Tool.d.ts:843`) and the fluent `addDependency(tag)` (`Tool.d.ts:243`) add
  *request-level* requirements: they flow into `Tool.HandlerServices<T>` (`Tool.d.ts:679`) and from
  there into `LanguageModel.ExtractServices<Options>` (`LanguageModel.d.ts:343`) — i.e. the tags
  must be in context **at the `generateText`/`streamText` call site**, not at `toLayer` time. This
  is the mechanism for per-request context (e.g. a per-run session tag).
- **`failureMode`** (`Tool.d.ts:86-96`): `"error"` puts handler failures in the Effect error channel
  of the model call (`Tool.HandlerError`, `Tool.d.ts:763`); `"return"` captures them into the
  tool result (`isFailure: true`) that the *model sees* — with the result type widened to include
  `AiError` (`Tool.d.ts:641-672`; runtime at `Toolkit.js:113-119`).
- **`needsApproval`** (`Tool.d.ts:98-133`, field at `:232`): see approval flow below.
- Fluent modifiers: `setParameters` / `setSuccess` / `setFailure` (`Tool.d.ts:247-270`), `annotate`
  / `annotateMerge` (`Tool.d.ts:274-278`; annotations are a `Context.Context<never>`, `Tool.d.ts:220`).

**`Tool.dynamic`** (`Tool.d.ts:905-971`) — the one we compile terms into:

```ts
Tool.dynamic(name, {
  description?, parameters?: Schema.Constraint | JsonSchema.JsonSchema,
  success?, failure?, failureMode?, needsApproval?
}) => Dynamic<Name, Config>
```

Two modes (`Tool.d.ts:355-413`): with an **Effect Schema**, params are decoded/validated exactly as
`Tool.make`; with a **raw JSON Schema**, the schema is passed to the model verbatim
(`Dynamic.jsonSchema`, `Tool.d.ts:412`), the handler receives `unknown`, and **no validation runs**
(`Toolkit.js:25` — `decodeParameters` degrades to `Effect.succeed`). A Dynamic tool IS a `Tool`
(interface extends it, `Tool.d.ts:396-406`), so toolkits mix them freely. Note `dynamic` does NOT
take `dependencies` — if a dynamic tool's handler needs request-level context, provide it around the
call site or close over it in the handler.

**`Tool.providerDefined`** (`Tool.d.ts:1009-1060`) — provider builtins (web search, code exec):
curried; identified by `id: "provider.tool_name"`, `customName` (toolkit-unique name), and
`providerName` (wire name); optional `requiresHandler: true` forces a user handler for
provider-generated results (`Tool.d.ts:352`, `RequiresHandler` at `:781`). The **`NameMapper`**
(`Tool.d.ts:1075-1106`) maps `customName ↔ providerName` so two providers' `web_search` don't
collide in one toolkit.

### JSON schema & annotations

- `Tool.getJsonSchema(tool, {transformer?})` (`Tool.d.ts:1173-1175`) → the parameters JSON Schema,
  optionally rewritten by a provider `CodecTransformer`; `getJsonSchemaFromSchema`
  (`Tool.d.ts:1189-1191`) is the schema-level primitive (resolves top-level `$ref`, attaches `$defs`).
- Annotations, all `Context` keys/references (`Tool.d.ts:1192-1358`): `Title` (string), `Meta`
  (MCP `_meta`), `Readonly` (default `false`), `Destructive` (default `true`), `Idempotent`
  (default `false`), `OpenWorld` (default `true`) — emitted as the corresponding MCP hints — and
  `Strict: boolean | undefined` (per-tool override of provider strict-JSON-schema mode; read via
  `getStrictMode`, `Tool.d.ts:1358`).
- `unsafeSecureJsonParse` (`Tool.d.ts:1376`): prototype-pollution-safe JSON parse used for streamed
  tool params.

### The approval flow (`needsApproval`) — how it surfaces

Verified end-to-end in `LanguageModel.js`:

1. When the model emits a `tool-call` for a tool whose `needsApproval` resolves `true`
   (`isApprovalNeeded`, `LanguageModel.js:956-969` — a function form gets decoded params +
   `{toolCallId, messages}` and may return an `Effect<boolean>`), the framework does **not** run the
   handler. It mints an `approvalId` via `IdGenerator` and emits a **`tool-approval-request`**
   response part `{approvalId, toolCallId}` (`LanguageModel.js:1070-1078`, stream: `:703-713`).
   In `generateText` the request part is included in the returned content (filter at `:516`).
2. The caller must persist that assistant turn (including the approval-request part), obtain a
   decision out-of-band, and append a **tool message** containing a
   `tool-approval-response` part `{approvalId, approved, reason?}` (`Prompt.d.ts:599-662`).
3. On the **next** `generateText`/`streamText` call with that history, pending approvals are
   collected (`collectToolApprovals`, `LanguageModel.js:858-918`), approved calls are executed
   *before* the model round (`executeApprovedToolCalls`, `:970-1005`), denials synthesize
   `{type: "execution-denied", reason}` failure results (`createDenialResults`, `:1006-1022`) —
   satisfying the pairing invariant — and the resolved approval artifacts are stripped from the
   wire prompt (`stripResolvedApprovals`, `:928-955`). A toolkit **must** be present on that call or
   you get `AiError` reason `ToolkitRequiredError` (`:396-404`).

So effect/ai's approval is a **park-across-calls protocol encoded in Prompt history** — exactly the
shape of our durable `Ask`, minus durability (which is ours to supply).

---

## 4. Toolkit

### Construction & merging

- `Toolkit.make(...tools)` (`Toolkit.d.ts:212`) → `Toolkit<ToolsByName<Tools>>`; keys are tool names.
- `Toolkit.merge(...toolkits)` (`Toolkit.d.ts:270-274`); later toolkits win name conflicts.
- `Toolkit.empty` (`Toolkit.d.ts:176`).

### The crucial structural fact

`Toolkit<Tools>` **extends `Effect<WithHandler<Tools>, never, Tool.HandlersFor<Tools>>`**
(`Toolkit.d.ts:40`). Yielding a toolkit resolves its handlers *from the ambient context*; the result
is a `WithHandler`:

```ts
// Toolkit.d.ts:133-156
interface WithHandler<Tools> {
  readonly tools: Tools
  readonly handle: <Name extends keyof Tools>(name: Name, params: Tool.Parameters<Tools[Name]>)
    => Effect<Stream<Tool.HandlerResult<Tools[Name]>, Tool.HandlerError<Tools[Name]>, Tool.HandlerServices<Tools[Name]>>, AiError>
}
```

### Attaching handlers — the actual APIs

Three, all on the toolkit (`Toolkit.d.ts:50-64`, impl `Toolkit.js:136-156`):

- `toolkit.of(handlers)` — identity helper for type-safe handler records.
- `toolkit.toHandlers(build)` → `Effect<Context<Tool.HandlersFor<Tools>>>` — build may be a record
  **or an Effect producing one**; it snapshots the *current context* (`yield* Effect.context()`,
  `Toolkit.js:140`) into each `Handler` entry.
- `toolkit.toLayer(build)` → `Layer<Tool.HandlersFor<Tools>, EX, Exclude<RX, Scope>>` — the Layer
  form (`Layer.effectContext(this.toHandlers(build))`, `Toolkit.js:154-156`).

Handler signature (`HandlersFrom`, `Toolkit.d.ts:124-126`):

```ts
(params: Tool.Parameters<T>, context: HandlerContext<T>)
  => Effect<Tool.Success<T>, Tool.Failure<T> | AiError | AiErrorReason, Tool.HandlerServices<T>>
```

`HandlerContext` (`Toolkit.d.ts:72-82`) provides `preliminary(result)` — emit intermediate results
that stream to the caller as `preliminary: true` tool-result parts before the final one
(`Toolkit.js:69-76`; `HandlerOutput` tagging at `Tool.d.ts:749-755`).

**Handlers can be Effects with `R`** — two channels: (a) the context captured at
`toHandlers`/`toLayer` construction time is merged in at execution (`Effect.updateContext(input =>
Context.merge(schemas.context, input))`, `Toolkit.js:81`), so anything in scope when you build the
handlers is available; (b) declared `dependencies` on the tool surface as `Tool.HandlerServices` and
must be provided at the model-call site. This is precisely what lets our Stage-A link phase resolve
term impls from ambient context and close over them.

Failure propagation (`Toolkit.js:39-127`): params failing schema decode → `AiError` reason
`ToolParameterValidationError` (`:59-67`) in `handle`'s outer error; handler failure → normalized
(`SchemaError` → `InvalidToolResultError`; bare `AiErrorReason` → wrapped `AiError`, `:94-109`) and
then routed per `failureMode` (`:113-119`): `"error"` fails the stream (→ fails the whole model
call), `"return"` becomes `{result: error, isFailure: true}` which the pipeline encodes and hands
back to the model. Defects (non-error throws) propagate as defects (`Queue.failCause`, `:82`).
Results are encoded via the success/failure schema; encode failure → `ToolResultEncodingError`
(`:85-93`).

**Dynamic tools with raw JSON Schema**: handler receives the raw `unknown` params (no decode,
`Toolkit.js:25`); success/failure default to `Schema.Unknown`/`Schema.Never` (`Tool.d.ts:960-966`)
so encode is pass-through. Runtime assembly from term data is fully supported: `Toolkit.make` takes
tools built at runtime, and `HandlersFrom` is keyed by tool name so a `Record<string,
Tool.AnyDynamic>` toolkit accepts a plain record of `(params: unknown) => Effect<unknown, ...>`
handlers.

---

## 5. Prompt & Chat

### Prompt model

- **Messages** (`Prompt.d.ts:1248`): `SystemMessage` (`content: string`, `:862-867`), `UserMessage`
  (`content: (TextPart | FilePart)[]`, `:941-953`), `AssistantMessage` (`content: (TextPart |
  FilePart | ReasoningPart | ToolCallPart | ToolResultPart | ToolApprovalRequestPart)[]`,
  `:1066-1078`), `ToolMessage` (`content: (ToolResultPart | ToolApprovalResponsePart)[]`,
  `:1182-1194`).
- **Parts** (`Prompt.d.ts:45`): `text`, `reasoning`, `file` (`mediaType`, `fileName?`, `data:
  string | Uint8Array | URL`, `:306-319`), `tool-call` (`id`, `name`, `params: unknown`,
  `providerExecuted`, `:396-413`), `tool-result` (`id`, `name`, `isFailure`, `result: unknown`,
  `:492-509`), `tool-approval-response` (`approvalId`, `approved`, `reason?`, `:599-612`),
  `tool-approval-request` (`approvalId`, `toolCallId`, `:689-698`).
- **Every message and every part carries `options: ProviderOptions`** — `Record<string, Json |
  null>` keyed by provider name (`Prompt.d.ts:16-24`, `BasePart:64-74`, `BaseMessage:763-773`),
  extended per provider via module augmentation (this is where Anthropic `cacheControl` lives, §7).
- **Constructors/combinators**: `makePart` (`:113-132`), `makeMessage` (`:810-818`), `make(RawInput)`
  (`:1377`), `fromMessages` (`:1401`), **`fromResponseParts`** (`:1441` — folds a model response
  back into assistant + tool messages; this is the transcript-append primitive), `concat` (`:1466`),
  `setSystem` / `prependSystem` / `appendSystem` (`:1550`, `:1648`, `:1742`).
- **Serializable end-to-end**: `Prompt` and `Message` are Schema codecs (`Prompt.d.ts:1262`,
  `:1303`) with plain-JSON encoded forms (`PromptEncoded`, `:1291-1296`); `RawInput` accepts the
  encoded form directly (`:1330`).

### Chat

`Chat` is a `Context.Service` (`Chat.d.ts:49`) with `Service` (`Chat.d.ts:66-269`):

- `history: Ref.Ref<Prompt.Prompt>` (`:89`) — direct access, mutate at will.
- `export: Effect<unknown, AiError>` / `exportJson: Effect<string, AiError>` (`:115`, `:143`) — the
  export **is just the schema-encoded history prompt** (`Chat.js:74-83`); restore via `fromExport`
  (`Chat.d.ts:412`) / `fromJson` (`:452`), which fail with `SchemaError` on bad data. So Chat state
  is serializable end-to-end, and the export contains exactly the message list (no usage, no
  budgets, no run state).
- Constructors: `empty` (`:300`), `fromPrompt(RawInput)` (`:363`).
- `generateText` / `streamText` / `generateObject` (`:174-268`) mirror `LanguageModel`'s overloads
  and **auto-append**: verified at `Chat.js:86-121` — under a 1-permit semaphore, history is
  concatenated with your new prompt, the model is called, and
  `Prompt.concat(prompt, Prompt.fromResponseParts(response.content))` is `Ref.set` back. For
  `streamText` the append happens in the stream's release phase with all collected parts
  (`Chat.js:100-106`). The semaphore serializes concurrent generations on one Chat.
- **Persistence** (`Chat.d.ts:483-581`): `Persistence.Service` = `get(chatId, {timeToLive?})` (fails
  `ChatNotFoundError`) and `getOrCreate(...)`, both returning `Persisted` — a `Chat` + `id` +
  `save` where every generate call auto-saves (`Chat.js:402-405`). Built by
  `makePersisted({storeId})` / `layerPersisted({storeId})` over **`BackingPersistence`**
  (`effect/unstable/persistence/Persistence.d.ts:82-97`): a store-of-KV-stores —
  `make(storeId) → { get(key) → object|undefined, set(key, value, ttl), remove, clear }`. That
  contract fits a DO trivially (DO storage or SQLite as the KV), but note it is whole-value
  put/get — the persisted chat is saved as one blob per chat id, no append-only structure.

---

## 6. Response — the StreamPart union

`Response.StreamPart<Tools>` (`Response.d.ts:109`) — every variant, with fields:

| Part `type` | Fields | Cite |
|---|---|---|
| `text-start` / `text-delta` / `text-end` | `id`; delta carries `delta: string` | `:310`, `:356`, `:410` |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | `id`; delta carries `delta` | `:514`, `:560`, `:614` |
| `tool-params-start` | `id`, `name`, `providerExecuted` | `:664-678` |
| `tool-params-delta` | `id`, `delta` (JSON fragment) | `:734-743` |
| `tool-params-end` | `id` | `:793-798` |
| `tool-call` | `id`, `name`, `params` (typed per tool), `providerExecuted` | `:863` (typed map `ToolCallParts<Tools>` `:130`) |
| `tool-result` | `id`, `name`, `result` (typed), `encodedResult: unknown`, `isFailure`, `providerExecuted`, `preliminary` | `:944-1049` (typed map `ToolResultParts<Tools>` `:139`) |
| `tool-approval-request` | `approvalId`, `toolCallId` | `:1164-1176` |
| `file` | `mediaType`, `data: Uint8Array` | `:1240` |
| `source` (document) | `id`, `mediaType`, `title`, `fileName?` | `:1300` |
| `source` (url) | `id`, `url`, `title` | `:1396` |
| `response-metadata` | `id?`, `modelId?`, `timestamp?`, `request?` (HTTP details) | `:1548-1565` |
| `finish` | `reason: FinishReason`, `usage: Usage`, `response?` (HTTP details) | `:1739-1752` |
| `error` | `error: unknown` | `:1826-1828` |

Every part carries provider `metadata: ProviderMetadata` (`:149-157`, `BasePart:165`). The
non-streaming `Part<Tools>` union (`:88`) is the folded subset (no start/delta/end, no error).
`Response.StreamPart(toolkit)` (`:123`) builds the Schema codec for a *specific* toolkit — this is
what decodes typed tool-call params. Tool-call resolution appears in the stream as: `tool-params-*`
(if the provider streams args) → `tool-call` → either `tool-result` (handler ran; possibly several
`preliminary: true` then the final) or `tool-approval-request` (parked) — with `finish` guaranteed
after all tool results (`LanguageModel.js:733-756`).

**ResponseIdTracker** (`ResponseIdTracker.d.ts:46-80`): optional service consulted by
`LanguageModel` (`LanguageModel.js:370`, `:528`). It remembers which prompt *message object
identities* were already seen under which provider response id; when the current prompt has a fully
tracked prefix, the model call is made **incrementally** — `previousResponseId` + only the suffix
messages (`prepareUnsafe`, marked back via `markParts` on `response-metadata`). Purpose: providers
with server-side conversation state (OpenAI Responses API `previous_response_id`,
`OpenAiLanguageModel.js:194,323`; provided by `OpenAiClient.layerWebSocketMode`,
`OpenAiClient.d.ts:263`). Note it keys on object identity — a serialization round-trip (DO
eviction) silently disables incrementality (safe: full prompt is re-sent).

---

## 7. Model & the providers

### Model (`Model.d.ts`)

`Model<Provider, Provides, Requires>` **extends `Layer<Provides | ProviderName | ModelName, never,
Requires>`** (`Model.d.ts:30-40`) and adds `provider` plus `captureRequirements:
Effect<Layer<Provides | ProviderName | ModelName>, never, Requires>` — the trick for constructing a
fully-provided model Layer from inside another service. `Model.make(provider, modelName, layer)`
(`:104-116`). `ProviderName`/`ModelName` are string services (`:54`, `:69`) — model identity is
inspectable from context, which suits our per-turn `CallModel` model-resolution.

### Anthropic (`@effect/ai-anthropic`)

Layer chain: `HttpClient → AnthropicClient → LanguageModel`.

```ts
// AnthropicClient.d.ts:162,177,194
AnthropicClient.layer({ apiKey?, apiUrl?, apiVersion?, transformClient? })
  : Layer<AnthropicClient, never, HttpClient.HttpClient>
AnthropicClient.layerConfig(...)   // Config-module-driven variant

// AnthropicLanguageModel.d.ts:694,715,734
AnthropicLanguageModel.model(model, config?) : Model<"anthropic", LanguageModel, AnthropicClient>
AnthropicLanguageModel.make({ model, config? }) : Effect<LanguageModel.Service, never, AnthropicClient>
AnthropicLanguageModel.layer({ model, config? }) : Layer<LanguageModel, never, AnthropicClient>
AnthropicLanguageModel.withConfigOverride(effect, overrides)      // scoped per-call config (:758)
```

The `Config` service (`AnthropicLanguageModel.d.ts:22-167`) carries the Messages-API request
surface: `model`, `thinking` (adaptive/disabled/budgeted), `max_tokens`, **`cache_control`**
(request default), `context_management` (server-side compaction/clear edits!), `container`/skills,
sampling params, `service_tier`, `speed`, `mcp_servers`, `output_format`, `system` (with
per-block cache_control), `disableParallelToolCalls`, `strictJsonSchema`. Client transport is
`createMessage`/`createMessageStream` over SSE (`AnthropicClient.d.ts:38-59`).

**Prompt caching (Anthropic)** — per-message and per-part provider options, via module augmentation
of `effect/unstable/ai/Prompt` (`AnthropicLanguageModel.d.ts:187-262` for messages, additional
per-part options through `:436`):

```ts
{ role: "system", content: "...", options: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } }
```

Implementation (`AnthropicLanguageModel.js:1998`, `:309-320`): `getCacheControl(part) ??
(isLastPart ? getCacheControl(message) : null)` — a message-level breakpoint is applied to the
message's **last content block**, which is exactly Anthropic's breakpoint semantics. Cache usage
comes back split: `cache_creation_input_tokens` → `usage.inputTokens.cacheWrite`,
`cache_read_input_tokens` → `cacheRead`, uncached → `uncached`, `total` = sum
(`AnthropicLanguageModel.js:1238-1248`). One gap noted in source: tool-message content blocks have a
`TODO: use cache_control in content blocks` (`AnthropicLanguageModel.js:435-436`) — a breakpoint on
a *tool* message's parts is currently dropped for the streaming path; put breakpoints on
system/user/assistant messages.

### OpenAI (`@effect/ai-openai`)

Same shape: `OpenAiClient.layer({apiKey, ...}) : Layer<OpenAiClient, never, HttpClient>`
(`OpenAiClient.d.ts:132`), `OpenAiLanguageModel.model/make/layer`
(`OpenAiLanguageModel.d.ts:518,541,568`). It targets the **Responses API**. `Config`
(`OpenAiLanguageModel.d.ts:60-104`): `model`, `temperature`/`top_p`, `reasoning: {effort, summary}`,
`max_output_tokens`, `truncation`, **`store`**, **`previous_response_id`**, `conversation`,
`service_tier`, `max_tool_calls`, `text.verbosity`, `strictJsonSchema`, `include`
(e.g. `"reasoning.encrypted_content"`).

**Prompt caching (OpenAI)**: there is **no `prompt_cache_key` / explicit cache-key surface** in this
package (grep over dist: zero hits). OpenAI-side caching here is (a) implicit prefix caching —
served by keeping our rendered-term prefix byte-stable, which is our own §3.2
`fold → render → markCacheBoundaries` job — and (b) server-side state reuse via
`previous_response_id`/`store` + `ResponseIdTracker` (provided by `OpenAiClient.layerWebSocketMode`,
`OpenAiClient.d.ts:263`, or manually). Reasoning continuity across calls uses the
`ReasoningPartOptions.openai.encryptedContent` prompt option (`OpenAiLanguageModel.d.ts:149-165`).

### Structured-output helpers

`AnthropicStructuredOutput.toCodecAnthropic(schema)` (`AnthropicStructuredOutput.d.ts:34-37`) and
`OpenAiStructuredOutput.toCodecOpenAI(schema)` (`OpenAiStructuredOutput.d.ts:33`) are
`CodecTransformer`s (`LanguageModel.d.ts:99-102`): they rewrite a codec's *encoded* side into the
provider's supported JSON-Schema subset (tuples→numeric-key objects, records→entry arrays,
optionals→required-nullable; `oneOf`→`anyOf`) while preserving the decoded type, and throw on
unsupported kinds rather than emit lossy schemas. **When needed**: only if you call
`generateObject`/strict tools with schemas outside the provider subset AND you are wiring
`LanguageModel.make` yourself — the provider packages already install their transformer. For our
halt-schema `resolve` tool, plain `Tool.dynamic` with an Effect Schema is enough; the provider
adapters apply their transformer to tool JSON schemas via `getJsonSchema`'s `transformer` hook.

---

## 8. Errors, telemetry, tokenizer

### AiError

One class, closed reason union (`AiError.d.ts:1189`, class at `:1268-1284`):

```ts
AiError { module: string; method: string; reason: AiErrorReason }
  get isRetryable(): boolean          // delegates to reason (:1276)
  get retryAfter(): Duration | undefined   // e.g. RateLimitError (:1282)
```

Reasons: `RateLimitError`, `QuotaExhaustedError`, `AuthenticationError`, `ContentPolicyError`,
`InvalidRequestError`, `InternalProviderError`, `NetworkError`, `InvalidOutputError`,
`StructuredOutputError`, `UnsupportedSchemaError`, `UnknownError`, `ToolNotFoundError`,
`ToolParameterValidationError`, `InvalidToolResultError`, `ToolResultEncodingError`,
`ToolConfigurationError`, `ToolkitRequiredError`, `InvalidUserInputError`. It is a Schema class
(serializable, `AiErrorEncoded` at `:1291`). Constructors: `AiError.make({module, method, reason})`
(`:1358`), `reasonFromHttpStatus` (`:1387`). Handling: `Effect.catchTag("AiError", ...)` +
`error.reason._tag`, or v4's `Effect.catchReason("AiError", "InvalidRequestError", ...)` (used
internally, `LanguageModel.js:383`).

**Retry/timeout: there is NO built-in retry anywhere in the pipeline.** The only automatic recovery
is the incremental→full-prompt fallback on `InvalidRequestError` (`LanguageModel.js:372-384`). We
wrap model calls with `Effect.retry` using `error.isRetryable` / `error.retryAfter` — which is what
our per-command budget accounting wants anyway (retries are visible commands, not hidden).

### Telemetry

`gen_ai.*` OTel semantic-convention attribute types (`Telemetry.d.ts:30-37`; request/response/usage
groups through `:370`), `addGenAIAnnotations(span, attributes)` (`:384`) writer, and the
**`CurrentSpanTransformer`** service (`:489-513`): `(options: ProviderOptions & {response:
Part[]}) => void`, called by `LanguageModel` after each generation with the full provider options +
response (`LanguageModel.js:249-250`, `:348-363` — for streams it buffers all parts and fires in
`Stream.ensuring`). Spans created per call: `LanguageModel.generateText` / `.generateObject` /
`.streamText` (`LanguageModel.js:252`, `:282`, `:328`) with `concurrency`/`toolChoice` attributes;
Toolkit annotates the current span with `{tool, parameters}` (`Toolkit.js:41-44`). Providers ship
their own span enrichment (`AnthropicTelemetry`/`OpenAiTelemetry`). This slots under our Trace as
OTel export — it does not compete with `KernelEvent`s.

### Tokenizer

Interface only (`Tokenizer.d.ts:76-97`): `tokenize(input: Prompt.RawInput) → Effect<number[],
AiError>` and `truncate(input, tokens) → Effect<Prompt>`; `make({tokenize})` derives `truncate` by
keeping the **newest messages that fit** (module doc `:1-12`). No provider tokenizer ships in these
packages — per-provider token counting remains unscoped harness work (§9.4 risk confirmed).

---

## 9. MCP (one paragraph)

`McpServer` exposes our tools outward: `McpServer.registerToolkit(toolkit)` / `McpServer.toolkit(toolkit)`
(`McpServer.d.ts:282-289`) publish any `Toolkit` as MCP tools (annotations → MCP hints;
`Tool.Meta` → `_meta`), with `layerStdio({name, version, stdin, stdout})` (`:246`) and `layerHttp`
(`:270`) transports; `resource`/`prompt`/`elicit` (`:393`, `:484`, `:504`) cover the rest of the
protocol, and `McpSchema` (3.4k lines) is the full typed protocol. Consuming MCP tools inward is the
job of `Tool.dynamic` with raw JSON Schema (explicitly designed for "MCP tools discovered at
runtime", `Tool.d.ts:363-390`) — an MCP client listing becomes `Tool.dynamic(name, {description,
parameters: jsonSchema})` entries whose handlers proxy `tools/call`. Since our terms already compile
to `Tool.dynamic` + handlers, exposing an Alchemy agent's toolkit over MCP later is
`McpServer.toolkit(compiledToolkit)` — near-zero marginal work.

---

## 10. Gap analysis against the Alchemy pipeline

| # | Need | effect/ai provides? | Integration shape |
|---|---|---|---|
| (a) | Multi-turn tool loop w/ custom stops (halt-as-tool, check verdicts, budget ceilings) | **Not provided — by design.** `generateText`/`streamText` are exactly ONE model round; nothing drives continuation (`LanguageModel.js:369-526`). | Perfect fit: our §2.4 step machine owns the loop. effect/ai cannot fight us because it has no loop to fight with. Halt-as-tool = a `Tool.dynamic("resolve", {parameters: haltSchema})` we inject; `toolChoice: {oneOf: [...]}` / `"required"` gives us the bounded-nag lever. |
| (b) | Per-command budget accounting (usage per call, cache splits, per-tool cost hooks) | **Partial.** Every round ends with a `finish` part carrying `Usage` incl. `cacheRead`/`cacheWrite`/`uncached`, all `number \| undefined` (`Response.d.ts:1655-1708`; Anthropic mapping `AnthropicLanguageModel.js:1238-1248`). No cost hooks, no per-tool-call metering. | Step machine decrements on the `finish` part of each `CallModel` feedback (declared unknown-usage policy for the `undefined`s, §9.3). Per-`CallTool` cost is ours: we execute handlers ourselves (see g), so metering wraps our own dispatch. |
| (c) | Tool-call approval/park vs durable Ask | **Partial — protocol yes, durability no.** `needsApproval` (bool/fn/Effect) parks a call as a `tool-approval-request` part; the answer is a `tool-approval-response` part in history; next call pre-executes/denies and repairs pairing (`LanguageModel.js:456-477`, `:956-1022`). | Two options. (1) Adopt their protocol: our Ask writes the approval-response into the transcript we feed back — we get pairing repair of approvals for free; durability is our ledger. (2) Since we run with `disableToolCallResolution`-style ownership (see g), we intercept `tool-call` commands ourselves and `needsApproval` never fires — our `Ask` + `ToolInterceptor` subsume it. Either way no conflict; the Prompt part vocabulary (`tool-approval-request/-response`) is worth reusing as our wire format for approval events. |
| (d) | Steering mid-run | **Not provided — confirmed.** A `streamText` call's prompt is fixed at invocation (`ProviderOptions.prompt`, `LanguageModel.d.ts:394`); the stream is output-only; no injection API exists. `Chat` serializes turns behind a semaphore (`Chat.js:71`). | Matches our doctrine: steering is between turns, promoted at the iteration boundary. Nothing to integrate; the boundary is ours. |
| (e) | Serializable state for DO eviction/resume | **Partial.** `Prompt` is a Schema codec end-to-end; `Chat.export` = encoded history, `fromExport` restores (`Chat.js:74-83`). Not in the export: usage, budgets, pending command state, approval bookkeeping beyond what's in messages. `ResponseIdTracker` state is identity-based and non-serializable (safe degradation). | Our `StepState` embeds `PromptEncoded` (or message list) as the transcript carrier — NOT a `Chat` (Chat's Ref+semaphore is process-local convenience we re-derive from state). `Prompt.fromResponseParts` (`Prompt.d.ts:1441`) is the fold-append primitive; repair-on-read composes as a pure `MessageEncoded[] → MessageEncoded[]` pass before `Prompt.make`. |
| (f) | Delegation tools calling back into our ProcessService | **Yes.** Handlers are `(params, ctx) => Effect<A, E, R>`; `R` comes from (i) context captured at `toLayer`/`toHandlers` build (`Toolkit.js:140`, merged at `:81`) and (ii) declared tool `dependencies` surfacing as `Tool.HandlerServices` → `ExtractServices` at the model-call site (`Tool.d.ts:679`, `LanguageModel.d.ts:343`). | Stage A resolves the callee's `ProcessService` from ambient context at link time and closes over it in the handler — `R = never` at run time, `RuntimeContext` satisfied by the host. `dispatch` return (summary) encodes via the tool's success schema. |
| (g) | Dynamic toolkit assembly per interpretation | **Yes — first-class.** `Tool.dynamic` exists for runtime schemas (`Tool.d.ts:355-390`); `Toolkit.make(...runtimeTools)` and record-typed `HandlersFrom` accept runtime records; the toolkit passed to a model call may itself be an Effect (`ToolkitInput`, `LanguageModel.d.ts:318-331`). Types check with `Record<string, Tool.AnyDynamic>`. | Stage A builds one `Toolkit.WithHandler` per term at Layer-construction time (see sketch, §11). We will typically also set `disableToolCallResolution: true` so the *kernel* executes `CallTool` commands (pairing invariant, interceptor, journaling) and calls `toolkit.handle` itself — the toolkit remains the executor, the step machine the scheduler. |
| (h) | Prompt-cache stability control | **Anthropic: yes, explicit** — per-message/part `options.anthropic.cacheControl` breakpoints (`AnthropicLanguageModel.d.ts:199-262`) + request-level `Config.cache_control`; usage returns read/write splits. **OpenAI: implicit only** — no cache-key API; `previous_response_id`/`store` + `ResponseIdTracker` for server-side reuse. | Our §3.2 `markCacheBoundaries` step writes `options.anthropic.cacheControl` onto the rendered-term system message and the last stable transcript message. For OpenAI, stability of the rendered prefix IS the control; optionally provide `ResponseIdTracker` per hot session (accepting it resets on eviction). Codex-style cache-stable synthetic ids: ours, via `IdGenerator` (provide a deterministic `Service`, `IdGenerator.d.ts:80-82` — also makes approval ids deterministic for replay). |
| (i) | Admission ledger, Trace, fold/check orchestration, budget enforcement, pairing repair | **Not provided; no overlap or conflict.** No inbox/queue, no event log (Telemetry is OTel-only), no fold/judge, no budgets, no message-repair pass (the only repair is approval-artifact stripping + denial synthesis, `LanguageModel.js:928-955`, `:1006-1022`). | All ours, as designed. One boundary to respect: if we DO let effect/ai resolve tool calls (not using `disableToolCallResolution`), it enforces its own mini-invariants (denials synthesized, finish-after-results) — our repair-on-read must treat those as already-paired, keyed by `callId`, which it does by construction. |

**Bottom line**: effect/ai is a *turn* library, not a *loop* library — it deliberately stops where
our kernel begins. The seams we need (dynamic tools, handler contexts, disableable resolution,
streamed parts as feedback, serializable prompts, cache splits in usage, provider options per
message) all exist and are typed. What it does not have — durability, admission, budgets, folds,
checks, steering, trace — is exactly the §2.4/§2.5 kernel, with zero duplicated machinery to fight.

---

## 11. Recommended kernel integration

Model provisioning (per-term physics, §2.2): the term's Layer stack provides
`LanguageModel` via e.g.

```ts
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"

const Claude = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layer({ apiKey: Redacted.make(env.ANTHROPIC_API_KEY) })),
  // AnthropicClient.layer requires HttpClient.HttpClient — FetchHttpClient on Workers
)
```

### Stage A — link: compile term refs → `Tool.dynamic` + Toolkit handlers

Compiling one of our `Tool` terms (impl resolved from ambient context) and one delegation tool
(an interpolated Agent's `ProcessService.dispatch`), using only verified APIs:

```ts
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as S from "effect/Schema"
import { isAgent } from "../AI/Agent.ts"
import { isHalt } from "../AI/Halt.ts"

// inside Kernel.interpret(term), at Layer-construction time:
const link = Effect.fnUntraced(function* (term: InterpretableTerm) {
  const tools: Array<Tool.AnyDynamic> = []
  const handlers: Record<string, (params: any) => Effect.Effect<unknown, AiError.AiError>> = {}

  for (const ref of term.refs) {
    if (isToolTerm(ref)) {
      // 1. our Tool term → Tool.dynamic (Effect Schema mode: validated params)
      const paramsSchema = S.Struct(collectParameterFields(ref))   // from interpolated Parameter refs
      tools.push(
        Tool.dynamic(ref["~alchemy/Name"], {
          description: renderTemplate(ref.template, ref.refs),     // the rendered tool prose
          parameters: paramsSchema,                                // Tool.d.ts:905-971
          success: S.Unknown,
          failureMode: "return",           // tool failures are model-visible results, never loop errors
        }),
      )
      // impl resolved from the AMBIENT context — this is why interpret carries the term's Req
      const impl = yield* ref                                      // ref IS a Context.Service tag
      const call = Effect.isEffect(impl) ? yield* impl : impl      // init-Effect or plain fn form
      handlers[ref["~alchemy/Name"]] = (params) => call(params)
    } else if (isAgent(ref)) {
      // 2. interpolated Agent → delegation tool wrapping dispatch (agent-as-tool, summary return)
      const callee = yield* ref                                    // AgentService = ProcessService
      tools.push(
        Tool.dynamic(ref["~alchemy/Name"], {
          description: `Delegate a work item to ${ref["~alchemy/Name"]} and await its summary.`,
          parameters: S.Struct({ input: S.Unknown }),
        }),
      )
      handlers[ref["~alchemy/Name"]] = ({ input }) => callee.dispatch(input)
    }
  }

  // 3. halt-as-tool: AI.until(schema) → synthetic resolve/give_up (§9.3)
  const halt = term.refs.find(isHalt)
  if (halt?.mode === "until" && halt.schema !== undefined) {
    tools.push(
      Tool.dynamic("resolve", { description: HALT_RESOLVE_PROMPT, parameters: halt.schema }),
      Tool.dynamic("give_up", { description: GIVE_UP_PROMPT, parameters: RefusalEvidence }),
    )
    handlers.resolve = (out) => Effect.succeed(out)   // graded by Check at the boundary, not here
    handlers.give_up = (why) => Effect.succeed(why)
  }

  // 4. one runtime toolkit; handlers close over resolved impls, so HandlersFor context is empty
  const toolkit = Toolkit.make(...tools)               // Toolkit.d.ts:212
  const withHandler = yield* toolkit.pipe(             // Toolkit<Tools> IS an Effect (Toolkit.d.ts:40)
    Effect.provide(toolkit.toLayer(handlers)),         // Toolkit.d.ts:60-64
  )
  return { withHandler, prompt: renderTerm(term), promptHash: hashRendered(term) }
})
```

Notes, all type-verified: dynamic tools accept Effect Schemas (validated) or raw JSON Schema
(unknown params); `failureMode: "return"` makes a handler failure a model-visible
`{isFailure: true}` result (`Toolkit.js:113-119`) — the confabulation-safe default for our tools;
`Toolkit.make` + `toLayer(record)` is the runtime-assembly path (handlers keyed by tool name,
`Toolkit.d.ts:124-126`); `withHandler.handle(name, params)` is the executor the kernel calls.

### Stage B — turn driver: step machine ↔ `streamText`

The kernel owns command execution; effect/ai supplies the model round and (optionally) the tool
executor. Two workable wirings — recommended: **`disableToolCallResolution: true`** so every
`CallTool` goes through our journal/interceptor/pairing machinery:

```ts
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

// one CallModel command → one model round → Feedback for the step machine
const runCallModel = Effect.fnUntraced(function* (
  cmd: CallModel, state: StepState, linked: Linked,
) {
  const prompt = Prompt.make(state.messages)         // StepState carries MessageEncoded[] — RawInput accepts it

  const parts: Array<Response.StreamPart<any>> = []
  yield* LanguageModel.streamText({
    prompt,
    toolkit: linked.withHandler,                     // advertised to the provider…
    disableToolCallResolution: true,                 // …but WE execute tool calls (LanguageModel.d.ts:164-172)
    toolChoice: state.phase === "nagging" ? { oneOf: ["resolve", "give_up"], mode: "required" } : "auto",
  }).pipe(
    Stream.runForEach((part) => {
      parts.push(part)
      switch (part.type) {
        case "text-delta":
        case "reasoning-delta":
          return emit(ModelDelta({ durable: false, part }))          // live-only, never advances seq
        case "tool-call":
          return emit(ToolRequested({ callId: part.id, name: part.name, params: part.params }))
        case "finish":
          // budget decrement is transactional with the Trace write (§2.4)
          return commitUsage(part.usage)             // cacheRead/cacheWrite/uncached splits, Response.d.ts:1655+
        default:
          return Effect.void
      }
    }),
    Effect.retry({                                    // no built-in retry — ours, budget-visible
      while: (e) => AiError.isAiError(e) && e.isRetryable,
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  )

  // fold the round into the transcript with the library's own append primitive
  const appended = Prompt.concat(prompt, Prompt.fromResponseParts(parts))   // Prompt.d.ts:1441,1466
  return ModelResponse({
    messages: encodePrompt(appended),                // Prompt is a Schema codec — StepState stays serializable
    toolCalls: parts.filter((p) => p.type === "tool-call"),
    finish: parts.find((p) => p.type === "finish"),
  })
})

// one CallTool command → toolkit.handle → exactly one ToolResult feedback (pairing invariant)
const runCallTool = Effect.fnUntraced(function* (cmd: CallTool, linked: Linked) {
  const gate = yield* interceptor.check(cmd)          // ToolInterceptor seam — may synthesize a block
  if (gate._tag === "Blocked") return ToolResult({ callId: cmd.callId, isFailure: true, result: gate.result })

  const stream = yield* linked.withHandler.handle(cmd.name, cmd.input)     // Toolkit.d.ts:147-155
  const final = yield* stream.pipe(
    Stream.filter((r) => r.preliminary === false),    // preliminary results are progress, not answers
    Stream.runLast,
  )
  return ToolResult({
    callId: cmd.callId,
    isFailure: final.isFailure,
    result: final.encodedResult,                      // pre-encoded, JSON-safe for the Trace (Tool.d.ts:714-735)
  })
})
```

The pure `step(state, feedback) → [state', commands]` sits above both: `ModelResponse` with
tool calls → `CallTool` commands (or `Ask` when our policy parks them); a `resolve`/`give_up` call →
boundary hand-off to Check; `finish.reason === "stop"` with no tool calls → the default halt
producer. `Feedback` is built from `StreamPart`s exactly as above — deltas are live-only events,
`tool-call`/`finish` are the durable ones.

Anthropic cache boundaries land where §3.2 dictates, at render time, before `CallModel`:

```ts
const marked = messages.map((m, i) =>
  i === stableBoundaryIndex
    ? { ...m, options: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } }
    : m,
)
```

Determinism: provide our own `IdGenerator` Layer (`IdGenerator.d.ts:80-82`) deriving ids from
`(session, stepIndex, ordinal)` so approval ids and any framework-minted ids are replay-stable.

### Honesty ledger (things the types don't say, resolved by reading the .js)

- `generateText` is single-round with post-hoc handler execution; `streamText` is single-round with
  concurrent handler fibers and finish-after-results ordering. Neither continues. (`LanguageModel.js:369-760`.)
- Approvals are resolved by *pre-executing* on the NEXT call, and resolved approval parts are
  stripped from the wire prompt (provider compatibility). (`LanguageModel.js:456-488`, `:928-955`.)
- Toolkit handlers execute in the context captured at `toHandlers`/`toLayer` time, merged into the
  caller's context. (`Toolkit.js:136-153`, `:81`.)
- `Chat.export` is nothing but the schema-encoded message history; a Chat gives no other state.
  (`Chat.js:74-83`.)
- Anthropic message-level `cacheControl` attaches to the message's last content block; per-part wins
  over per-message; tool-message parts currently drop it (source TODO). (`AnthropicLanguageModel.js:309-320`, `:435-436`, `:1998`.)
- `@effect/ai-openai` exposes no `prompt_cache_key`; OpenAI caching is implicit prefix caching plus
  `previous_response_id`/`store` via `ResponseIdTracker`. (grep of dist; `OpenAiLanguageModel.d.ts:60-104`, `.js:194,323`.)
- No retry, no timeout policy anywhere in `LanguageModel`/`Toolkit`; the only fallback is
  incremental→full prompt on `InvalidRequestError`. (`LanguageModel.js:372-384`.)

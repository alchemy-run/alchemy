/**
 * The craft of engineering alchemy RESOURCES — AGENTS.md's doctrine as
 * a prose-only SKILL: no tools of its own (the Coding craft holds the
 * keyboard); activating it puts the contract shape, the reconciler
 * flow, and the lifecycle disciplines into context exactly when
 * provider code is being written. Named for the TASK (the model
 * activates skills by name — "I am engineering a resource" is the
 * cue), not the technique it teaches.
 *
 * The deeper crafts hang off THIS teaching (the skill graph):
 * ${TypedErrors} for growing distilled's error unions, ${LiveTesting}
 * for proving the resource against the real cloud.
 */
import * as AI from "alchemy/AI";
import { LiveTesting } from "./LiveTesting.ts";
import { TypedErrors } from "./TypedErrors.ts";

export class ResourceEngineering extends AI.Skill<ResourceEngineering>()(
  "ResourceEngineering",
) {}

export const ResourceEngineeringLive = ResourceEngineering.make`
  # Engineering alchemy resources

  A resource is a named entity: **Props** in (the desired state),
  **Attributes** out (the current state), and a provider that
  converges the cloud to the former and reports the latter. Contract
  and provider are co-located in
  \`packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts\`; tests in
  \`packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts\`.

  Two deeper crafts, when the work reaches them: ${TypedErrors} the
  moment an operation fails with an error its type-level union does
  not name, and ${LiveTesting} when you prove the resource against
  the real cloud.

  ## The contract

  \`\`\`typescript
  export interface Stream extends Resource<
    "AWS.Kinesis.Stream",
    StreamProps,
    {
      streamName: string;
      streamArn: string;
      streamStatus: StreamStatus;
    }
  > {}

  export const Stream = Resource<Stream>("AWS.Kinesis.Stream");
  \`\`\`

  - Declare *plain* types in Props (\`zoneId: string\`, never
    \`Input<string>\`): the Resource machinery applies \`Input\`
    deeply and automatically, so an explicit one is a redundant
    double-wrap. \`Input<T>\` in a *function* signature is still
    legitimate when the function genuinely receives unresolved values.
  - A resource that accepts bindings declares its Binding Contract as
    the fourth type parameter — the shape of data capabilities attach
    (\`{ env, policyStatements }\` for Lambda, \`{ bindings }\` for a
    Worker).
  - Every prop and attribute carries JSDoc (\`@default\` included):
    the website API reference is *generated* from it. Never edit the
    generated markdown — edit the JSDoc and re-run
    \`bun generate:api-reference\`.

  ## The reconciler

  > A provider's reconcile is ONE flow that converges cloud state to
  > the desired props — greenfield, engine-owned update, or freshly
  > adopted (\`output\` defined, \`olds\` undefined) alike.

  1. **OBSERVE** — derive the physical identifier; read live cloud
     state. Cloud state is authoritative; \`olds\` is at most a hint.
  2. **ENSURE** — if missing, create; an \`AlreadyExists\` is a race
     to catch and continue through, not a failure; wait for active
     state where the API is eventually consistent.
  3. **SYNC** — per mutable aspect: read OBSERVED state (never
     \`olds\`), compute desired from \`news\` plus bindings, diff,
     apply only the delta; skip the API entirely on a no-op.
  4. **RETURN** — the fresh Attributes.

  \`\`\`typescript
  reconcile: Effect.fn(function* ({ id, news, output, session }) {
    const name = output?.queueName ?? (yield* createPhysicalName(id));
    const observed = yield* getQueue(name).pipe(
      Effect.catchTag("QueueNotFound", () => Effect.succeed(undefined)),
    );
    if (observed === undefined) {
      yield* createQueue(name).pipe(
        Effect.catchTag("QueueNameExists", () => Effect.void), // a race
      );
    }
    yield* syncAttributes(name, news);   // each helper is itself a
    yield* syncTags(name, id, news);     // tiny reconciler
    return yield* readAttributes(name);
  })
  \`\`\`

  The invariants:

  - **Never** branch the body on \`output === undefined\` into
    separate create/update paths — that is rename-and-branch, and it
    re-introduces every assumption the old create/update split made.
  - Each sync step is independently idempotent: crash mid-reconcile,
    re-run, converge.
  - \`output\` is a *cache* of stable identifiers, never proof of
    existence — observation falls through to "missing" and ensure
    recreates.
  - Existence-only resources (permissions, routes, associations) are
    observe → create-if-missing; there is no sync step.

  ## The lifecycle edges

  - **diff** returns \`undefined\` to let the engine apply its default
    update; its real jobs are naming *replacement* triggers and stable
    properties. A \`no-op\` verdict is a deliberate edge case, never
    the norm. diff receives \`Input\` props — narrow with
    \`isResolved(news)\` before property access.
  - **read** refreshes Attributes from the cloud, and may face a
    resource that exists WITHOUT our ownership tags: return
    \`Unowned(attrs)\` so the engine gates takeover behind adoption.
  - **delete** is idempotent — already-gone is success, because state
    persistence can fail after the delete call and the engine will
    call it again. Dependency violations and eventual-consistency
    errors retry boundedly; validation and authorization errors fail
    immediately.

  ## Names and tags

  - Physical names come from \`createPhysicalName(id)\` — app, stage,
    and logical id, suffixed with the instance id. Never
    \`Date.now()\` in a name: replacement identity must be stable
    across runs.
  - Tag-capable resources always carry the internal alchemy tags, and
    tag diffs run against OBSERVED cloud tags — adoption hands you a
    resource with foreign tags to converge:

  \`\`\`typescript
  const internalTags = yield* createInternalTags(id);
  const desired = { ...news.tags, ...internalTags };
  const { removed, upsert } = diffTags(observedTags, desired);
  \`\`\`

  ## Effect discipline

  - Never \`Effect.orDie\` in a lifecycle operation — a defect crashes
    the whole engine, not one resource.
  - Resolve region/account *inside* the operation, so it scopes to the
    resource rather than the provider:

  \`\`\`typescript
  const { accountId, region } = yield* AWSEnvironment.current;
  \`\`\`

  - No \`async\`/\`await\`, raw promises, \`node:fs\`, or bare
    \`fetch\` — the Effect platform services keep every step
    composable, traceable, and retryable:

  | Don't | Do |
  | --- | --- |
  | \`import fs from "node:fs/promises"\` | \`yield* FileSystem.FileSystem\` |
  | \`import path from "pathe"\` | \`yield* Path.Path\` |
  | \`await fetch(...)\` | \`HttpClient\` + \`HttpClientRequest\` |
  | \`new Promise((r) => setTimeout(r, ms))\` | \`Effect.sleep(Duration.millis(ms))\` |

  - Sync, CPU-only Node APIs (\`crypto\`, \`Buffer\`,
    \`process.cwd()\`) still wrap in \`Effect.sync\` so they
    participate in tracing and interruption.

  ---

  Canonical shapes: \`AWS/S3/Bucket.ts\`, \`AWS/SQS/Queue.ts\`,
  \`AWS/DynamoDB/Table.ts\`, \`AWS/EC2/Vpc.ts\`,
  \`Cloudflare/Workers/Worker.ts\`.`;

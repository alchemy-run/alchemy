/**
 * The TAG RUBRIC — the areas of the one Engineering stream, in code
 * (structure-is-code: the rubric IS the router's Choice cards, never
 * re-declared in prose elsewhere). A tag names WHERE the work lands
 * — a cloud surface, the SDK factory, the forge, the org's own
 * plumbing — while the queue stays singular: one lane, one pair of
 * desks, tags carrying the area.
 */

/** One tag's card, the Gate's rubric shape. */
export interface TagRubric {
  readonly what: string;
  readonly notFor?: string;
  readonly examples?: ReadonlyArray<string>;
}

export const TAG_RUBRICS: Record<string, TagRubric> = {
  cloudflare: {
    what:
      "Cloudflare provider work: Workers, Durable Objects, R2, KV, D1, " +
      "Queues — provider bugs, live-test failures, new resources on the " +
      "Cloudflare surface",
    notFor:
      "Fly machines, AWS services, or SDK codegen — those wear their own tags",
    examples: [
      "fix(r2): bucket CORS rules drift on adopt",
      "feat(do): alarm re-registration on eviction",
    ],
  },
  fly: {
    what:
      "Fly.io provider work: machine lifecycle, blue/green deploy safety, " +
      "ACME certificates, volumes, provider gaps",
    notFor:
      "Cloudflare or AWS surfaces — work that never touches a Fly machine",
    examples: [
      "fix(fly): machine restart loop on deploy",
      "feat(fly): volume snapshot resource",
    ],
  },
  aws: {
    what:
      "AWS provider work: Lambda, S3, DynamoDB, EC2, SQS and the rest — " +
      "resources, bindings, IAM policies, live-suite failures",
    notFor: "Cloud-agnostic engine work, or another cloud's surface",
    examples: [
      "fix(s3): bucket policy sync on adoption",
      "feat(lambda): SQS event source mapping",
    ],
  },
  distilled: {
    what:
      "The distilled SDK factory: Smithy models, JSON Patches, typed " +
      "error unions, service regeneration",
    notFor:
      "Consumer-side alchemy code — a provider bug that needs no SDK patch",
    examples: [
      "patch(cloudflare): type the not-found error on getWidget",
      "fix(codegen): snake_case member renames drop aliases",
    ],
  },
  forge: {
    what:
      "The forge and its surfaces: the git server, the whole-tree API, " +
      "the code browser, issues and pulls",
    notFor: "Provider or SDK work that merely lives in the repo",
    examples: [
      "fix(forge): tree API drops symlinks",
      "feat(code): blame view on the file page",
    ],
  },
  org: {
    what:
      "The org's own plumbing: agents, desks, task queues, chat, " +
      "sessions, routing, the root service",
    notFor: "Work on what the org ships — providers, SDKs, the forge",
    examples: [
      "fix(desks): digest delivered twice per claim",
      "feat(tasks): tag filter pills on the board",
    ],
  },
};

/** The declared tags, in rubric order — the UI's filter pills. */
export const KNOWN_TAGS: ReadonlyArray<string> = Object.keys(TAG_RUBRICS);

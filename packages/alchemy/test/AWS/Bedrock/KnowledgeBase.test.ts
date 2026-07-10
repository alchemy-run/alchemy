import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes. The full KnowledgeBase + DataSource + Retrieve
// lifecycle is gated behind a vector store (see KnowledgeBase.slow.test.ts);
// these cheap probes prove the distilled error union that the reconcilers'
// observe/read/delete catch paths depend on, at near-zero cost.

test.provider(
  "getKnowledgeBase on a missing id returns a typed ResourceNotFoundException",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* bedrock
        .getKnowledgeBase({ knowledgeBaseId: "AAAAAAAAAA" })
        .pipe(
          Effect.map(() => "found" as const),
          // Compiles only if ResourceNotFoundException is in the typed union.
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("not-found" as const),
          ),
        );
      expect(result).toBe("not-found");
    }),
  { timeout: 60_000 },
);

test.provider(
  "getDataSource on a missing id returns a typed ResourceNotFoundException",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* bedrock
        .getDataSource({
          knowledgeBaseId: "AAAAAAAAAA",
          dataSourceId: "BBBBBBBBBB",
        })
        .pipe(
          Effect.map(() => "found" as const),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("not-found" as const),
          ),
        );
      expect(result).toBe("not-found");
    }),
  { timeout: 60_000 },
);

test.provider(
  "getAgent on a missing id returns a typed ResourceNotFoundException",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* bedrock.getAgent({ agentId: "AAAAAAAAAA" }).pipe(
        Effect.map(() => "found" as const),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("not-found" as const),
        ),
      );
      expect(result).toBe("not-found");
    }),
  { timeout: 60_000 },
);

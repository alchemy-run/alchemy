import * as AWS from "@/AWS";
import * as Build from "@/Build";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "list returns [] for non-listable Build.Command",
  () =>
    Effect.gen(function* () {
      // Build.Command is a local build/exec step with no remote enumeration
      // API, so list() is the non-listable pattern: always returns [].
      const provider = yield* Provider.findProvider(Build.Command);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { timeout: 30000 },
);

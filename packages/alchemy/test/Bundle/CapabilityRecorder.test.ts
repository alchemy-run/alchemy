import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Bundle from "@/Bundle/Bundle";

/** What every runtime's entry pulls in: a binding, the platform that boots it, and a named term. */
const entry = (src: string) => `
import * as Binding from ${JSON.stringify(`${src}/Binding.ts`)};
import { framed, hostedBy, own, refer, standsFor } from ${JSON.stringify(`${src}/CapabilityGraph.ts`)};
import { Platform } from ${JSON.stringify(`${src}/Platform.ts`)};
import * as Effect from "effect/Effect";

export const Store = Binding.Service("Bench.Store");
export const platform = Platform;
export const term = framed("Tool", "lookup")(
  Effect.all([
    refer("uses", "Tool", "other"),
    own("Model", "Board", "Board.Issue"),
    hostedBy("Process", "Triage", "TriageProcess"),
    standsFor("Process", "Triage", {}),
  ]),
);
`;

layer(NodeServices.layer)("the capability recorder in a runtime bundle", (it) => {
  it.effect(
    "a deployed runtime holds clients to the plan's list, and carries none of what records it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.resolve(import.meta.dirname, "../..");
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-capability-bundle-" });
        const input = path.join(dir, "entry.ts");
        yield* fs.writeFileString(input, entry(path.join(root, "src")));
        const output = yield* Bundle.build({ input, cwd: root, platform: "node" });
        const code = output.files
          .filter((file) => file.path.endsWith(".js"))
          .map((file) =>
            typeof file.content === "string"
              ? file.content
              : new TextDecoder().decode(file.content),
          )
          .join("\n");

        // The check a runtime makes stays.
        expect(code.includes("CapabilityDenied")).toBe(true);
        // The graph, the wrapped memo map and the lookup tracer are plan-only,
        // and a named term's build has no frame made around it.
        const recorder = [
          "makeCapabilityGraph",
          "observeLayerBuilds",
          "observeLookups",
          "RecordingMap",
          "alchemy/CapabilityGraph/recording",
          "policyOf",
          "graph.frame(",
          "graph.refers(",
          "graph.owns(",
          "graph.hosts(",
          "graph.stands(",
          "graph.acquires(",
        ];
        expect(recorder.filter((each) => code.includes(each))).toEqual([]);
      }),
    { tags: ["unit", "local"], timeout: 120_000 },
  );
});

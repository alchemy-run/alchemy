import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Sandbox } from "../Sandbox.ts";

export const url = AI.Parameter("url", S.String)`
The URL to fetch content from.`;

export const format = AI.Parameter("format")(
  S.Literals(["text", "html"]).pipe(S.optional),
)`The format to return the content in (\`text\` or \`html\`). Defaults to \`html\`.`;

export class WebFetch extends AI.Tool<WebFetch>()("webfetch")`
- Fetches content from a specified ${url} from inside the sandbox
- Takes a URL and optional ${format} as input
- Returns the response body in the requested format
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: if another tool is present that offers better web fetching
    capabilities, is more targeted to the task, or has fewer restrictions,
    prefer using that tool instead of this one.
  - The URL must be a fully-formed valid URL.
  - HTTP URLs are automatically upgraded to HTTPS.
  - This tool is read-only and does not modify any files.` {}

export const WebFetchLive = Layer.effect(
  WebFetch,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    return Effect.fn("webfetch")(function* (params) {
      const { url } = params as { url: string; format?: "text" | "html" };
      const https = url.replace(/^http:\/\//, "https://");
      const result = yield* sandbox.exec(
        `curl -sSL --max-time 30 ${shellQuote(https)}`,
      );
      return result.stdout;
    });
  }),
);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

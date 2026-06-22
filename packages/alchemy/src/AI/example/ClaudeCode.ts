import * as Cloudflare from "../../Cloudflare/index.ts";

export class ClaudeCode extends Cloudflare.Container("ClaudeCode", {
  dockerfile: `
    FROM alpine:latest
    RUN curl -fsSL https://claude.ai/install.sh | bash
  `,
  context: ".",
}) {}

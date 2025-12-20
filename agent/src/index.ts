import { createOpencode, Session, Message, Part } from "@opencode-ai/sdk";

const opencode = await createOpencode({
  config: {
    model: "anthropic/claude-4-5-opus",
  },
});

const { client, server } = opencode;

console.log((await client.config.providers()).data);

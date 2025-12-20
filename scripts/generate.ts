import { createOpencode, Session, Message, Part } from "@opencode-ai/sdk";

const opencode = await createOpencode();

const { client, server } = opencode;

console.log((await client.provider.list()).data);

// TODO: automate fan-out of opencode to develop services

/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

/** Hosted from the first deploy. */
export class First extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("First");
  }
}

/** Exported from the start, but only hosted (bound) on the second deploy. */
export class Second extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("Second");
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("b");
  },
};

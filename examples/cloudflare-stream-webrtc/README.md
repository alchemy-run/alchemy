# cloudflare-stream-webrtc

Sub-second-latency live streaming on Cloudflare Stream over WebRTC, using
the WHIP (publish) and WHEP (playback) protocols.

There is no separate WebRTC or signaling resource to create — WHIP and WHEP
*are* the signaling, carried over plain HTTP. Every Stream live input is
reachable over both, so the whole stack is one `LiveInput` and one Worker.

```sh
bun run deploy    # prints the Worker URL
bun run destroy
```

Open the Worker URL, click **Start broadcasting** in one tab and **Play** in
another.

## Where the publish secret comes from

Cloudflare mints it when the live input is created — you never supply or
generate it. It is per-live-input, not per-account; the only account-wide
part of the URL is the `customer-<code>` subdomain:

```
https://customer-<CODE>.cloudflarestream.com/<SECRET>/webRTC/publish
```

Create a second `LiveInput` for a second concurrent broadcast.

## Why the two URLs are wired differently

Anyone holding the WHIP URL can publish to the input, so alchemy types it as
`Redacted` and this example keeps it inside the Worker:

```ts
env: {
  WHIP_URL: Broadcast.webRTCUrl,          // Redacted -> secret_text
  WHEP_URL: Broadcast.webRTCPlaybackUrl,  // plain string
}
```

The browser never sees `WHIP_URL`. It posts its SDP offer to the Worker's
`/whip` route, which authorizes the caller and then forwards the offer to
Cloudflare. Playback needs no such care: the page fetches the WHEP URL from
`/whep` and negotiates with Cloudflare directly.

Swap the bearer-key check in `src/Api.ts` for whatever decides who is
allowed to broadcast in your app.

## Beta limitations

WebRTC ingest is in beta and does not yet support recording, simulcasting,
live viewer counts, or analytics, and you cannot mix protocols on one input
(a WebRTC broadcast is not playable over HLS/DASH). RTMPS and SRT are
exposed on the same resource — `rtmps`, `rtmpsPlayback`, `srt`,
`srtPlayback` — if you need those.

See the [Cloudflare docs](https://developers.cloudflare.com/stream/webrtc-beta/).

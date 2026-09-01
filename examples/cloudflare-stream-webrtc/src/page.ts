/**
 * A minimal WHIP/WHEP demo page.
 *
 * Broadcasting posts its SDP offer to the Worker's `/whip` route, which
 * holds the secret publish URL. Playback fetches the public WHEP URL from
 * `/whep` and negotiates with Cloudflare directly — no secret involved.
 */
export const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Cloudflare Stream WebRTC</title>
<style>
  body { font: 14px system-ui; margin: 2rem; max-width: 52rem; }
  video { width: 100%; background: #111; border-radius: 8px; }
  .row { display: grid; gap: 1.5rem; grid-template-columns: 1fr 1fr; }
  button { padding: .5rem 1rem; }
  input { padding: .4rem; width: 16rem; }
  code { background: #f2f2f2; padding: .1rem .3rem; border-radius: 3px; }
</style>
<h1>Cloudflare Stream over WebRTC</h1>
<p>Sub-second latency via WHIP (publish) and WHEP (playback).</p>
<div class="row">
  <div>
    <h2>Broadcast (WHIP)</h2>
    <p>Key: <input id="key" value="dev-broadcast-key"></p>
    <p><button id="go">Start broadcasting</button></p>
    <video id="local" autoplay muted playsinline></video>
  </div>
  <div>
    <h2>Watch (WHEP)</h2>
    <p><button id="watch">Play</button></p>
    <video id="remote" autoplay playsinline></video>
  </div>
</div>
<p id="status"></p>
<script type="module">
const status = (m) => { document.getElementById("status").textContent = m; };

// Wait for ICE gathering so the offer we send is complete — Cloudflare's
// WHIP/WHEP endpoints take a single non-trickle offer.
const gathered = (pc) =>
  pc.iceGatheringState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => {
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") resolve();
        });
      });

const negotiate = async (pc, url, headers) => {
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const res = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/sdp" }, headers),
    body: pc.localDescription.sdp,
  });
  if (!res.ok) throw new Error(await res.text());
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
};

document.getElementById("go").onclick = async () => {
  try {
    status("requesting camera...");
    const media = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    document.getElementById("local").srcObject = media;

    const pc = new RTCPeerConnection();
    for (const track of media.getTracks()) pc.addTrack(track, media);

    // Posted to the Worker, not to Cloudflare — the Worker holds the secret.
    const key = document.getElementById("key").value;
    await negotiate(pc, "/whip", { authorization: "Bearer " + key });
    status("broadcasting");
  } catch (e) {
    status("broadcast failed: " + e.message);
  }
};

document.getElementById("watch").onclick = async () => {
  try {
    status("connecting...");
    const { url } = await (await fetch("/whep")).json();

    const pc = new RTCPeerConnection();
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (event) => {
      document.getElementById("remote").srcObject = event.streams[0];
    };

    // Straight to Cloudflare — the playback URL is public.
    await negotiate(pc, url, {});
    status("playing");
  } catch (e) {
    status("playback failed: " + e.message);
  }
};
</script>`;

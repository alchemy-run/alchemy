import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element");
}

app.innerHTML = `
  <main class="page">
    <p class="eyebrow">alchemy + vite</p>
    <h1>Deploy a Vite SPA to Hetzner Cloud.</h1>
    <p class="lede">
      This example runs <code>vite build</code> and serves the output from one
      <code>Hetzner.Service</code> on a Cloud Server. Under
      <code>alchemy dev</code> the site is Vite's own dev server — no Server
      or Service is created.
    </p>
    <p id="marker">HETZNER_VITE_PAGE_MARKER</p>
    <ul class="highlights">
      <li>Static assets baked into the systemd unit</li>
      <li>Generated Node static-file server on port 3000</li>
      <li>Public URL at <code>http://{ipv4}:3000</code></li>
    </ul>
  </main>
`;

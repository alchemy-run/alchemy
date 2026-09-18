import { createRemoteJWKSet, jwtVerify } from "jose";

const authUrl = process.env.NEON_AUTH_BASE_URL!;
const issuer = new URL(authUrl).origin;
const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL!));
const authRoutes = new Set([
  "/auth/sign-up/email",
  "/auth/sign-in/email",
  "/auth/sign-out",
  "/auth/token",
  "/auth/get-session",
]);

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      request.headers.has("origin") &&
      request.headers.get("origin") !== url.origin
    ) {
      return new Response("Untrusted origin", { status: 403 });
    }
    if (authRoutes.has(url.pathname)) {
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set("origin", url.origin);
      const base = authUrl.replace(/\/$/, "");
      const authBase = base.endsWith("/auth") ? base : `${base}/auth`;
      const upstream = new URL(
        `${authBase}${url.pathname.slice("/auth".length)}`,
      );
      return fetch(
        new Request(upstream, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.arrayBuffer(),
          signal: request.signal,
          redirect: "manual",
        }),
      );
    }
    if (url.pathname === "/api/profile") {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer "))
        return new Response("Sign in first", { status: 401 });
      try {
        const { payload } = await jwtVerify(authorization.slice(7), jwks, {
          issuer,
        });
        if (!payload.sub)
          return new Response("Invalid subject", { status: 401 });
        return Response.json({ userId: payload.sub, email: payload.email });
      } catch {
        return new Response(
          "Your token is invalid or expired. Sign in again.",
          { status: 401 },
        );
      }
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(page, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neon managed authentication</title><style>
body{font:16px system-ui;background:#101815;color:#e6f3ec;margin:0;padding:24px}main{max-width:560px;margin:5vh auto}h1{font-size:2rem}label{display:block;margin:16px 0 6px}input,button{font:inherit;padding:12px;border-radius:8px;box-sizing:border-box}input{display:block;width:100%;border:1px solid #6b8878;background:#182a21;color:white}button{border:0;background:#c5f5a8;color:#132219;margin:12px 8px 0 0;cursor:pointer}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#182a21;padding:16px;border-radius:8px}small{display:block;color:#a8bbaf;margin:16px 0}
</style></head><body><main><h1>Managed authentication</h1><p>Sign up, sign in, and call an API that verifies your short-lived JWT.</p>
<form id="auth"><label for="name">Name</label><input id="name" autocomplete="name" required value="Neon explorer">
<label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="8" required>
<button name="mode" value="signup">Create account</button><button name="mode" value="signin">Sign in</button></form>
<button id="profile">Call protected API</button><button id="invalid">Try invalid token</button><button id="signout">Sign out</button>
<pre id="status" role="status" aria-live="polite">Signed out. Protected API requests will return 401.</pre>
<small>This demo disables email verification. Enable it before production. Signout revokes the session; previously issued JWTs remain valid until their 15-minute expiry.</small>
<script type="module">
const status=document.querySelector('#status');let token;
const show=(message)=>status.textContent=message;
async function request(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const text=await response.text();if(!response.ok)throw new Error('HTTP '+response.status+': '+text);return text?JSON.parse(text):{};}
document.querySelector('#auth').addEventListener('submit',async(event)=>{event.preventDefault();const mode=event.submitter.value;show('Working…');try{await request('/auth/'+(mode==='signup'?'sign-up':'sign-in')+'/email',{name:document.querySelector('#name').value,email:document.querySelector('#email').value,password:document.querySelector('#password').value});token=(await request('/auth/token')).token;show('Signed in. You can now call the protected API.');}catch(error){token=undefined;show(error.message);}});
async function profile(value){const response=await fetch('/api/profile',{headers:value?{authorization:'Bearer '+value}:{}});show('HTTP '+response.status+'\\n'+await response.text());}
document.querySelector('#profile').onclick=()=>profile(token).catch(error=>show(error.message));
document.querySelector('#invalid').onclick=()=>profile('invalid.jwt.signature').catch(error=>show(error.message));
document.querySelector('#signout').onclick=async()=>{try{await request('/auth/sign-out',{});token=undefined;show('Signed out.');}catch(error){show(error.message);}};
try{const session=await request('/auth/get-session');if(session?.user){token=(await request('/auth/token')).token;show('Session restored. You can now call the protected API.');}}catch{token=undefined;show('Unable to restore your session. Sign in again.');}
</script></main></body></html>`;

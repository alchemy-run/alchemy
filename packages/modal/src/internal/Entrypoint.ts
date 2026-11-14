/**
 * The Python module a `Modal.Function` or `Modal.Server` container imports.
 *
 * Modal boots every Function container with its Python entrypoint, which
 * imports the function's module and looks the function up by name. This
 * module is that function: it starts the bundled program (`ALCHEMY_COMMAND`,
 * from the function's env secret) once per container and hands it work as
 * HTTP on `PORT`:
 *
 * - `Rpc` (a class function) has one method per RPC method of the program
 *   (`ALCHEMY_MODAL_RPC_METHODS`, from the function's env secret); a call is
 *   sent to the program's `POST /__rpc__/<method>` with the positional
 *   arguments as a JSON array and the caller's key (the
 *   `__alchemy_rpc_key__` keyword argument) as `x-alchemy-rpc-key`, and
 *   returns the JSON result (a value, or an
 *   error envelope the caller fails with). A streamed result is read to its
 *   end and returned as its list of values;
 * - `call` and `schedule` forward each input as `POST /__modal/call` or
 *   `POST /__modal/schedule` with a JSON body `{ "args": [...], "kwargs":
 *   {...} }`, and return the JSON response (an async program's calls, and
 *   schedule ticks);
 * - `web` (a `WEBHOOK_TYPE_WEB_SERVER` function) starts the program, then
 *   Modal proxies its `*.modal.run` URL to `PORT`;
 * - `Server` (`is_server`) starts the program in `@modal.enter`, then Modal
 *   routes the Server's URL to `PORT`.
 *
 * It's uploaded as a Mount (`/root/alchemy_modal.py`); the module name and
 * its function names are part of every function definition, so changing
 * them redeploys every function.
 */
export const ENTRYPOINT_MODULE = "alchemy_modal";

export const ENTRYPOINT_PATH = `/root/${ENTRYPOINT_MODULE}.py`;

/** Function implementations in {@link ENTRYPOINT_SOURCE}. */
export const ENTRYPOINT = {
  call: "call",
  schedule: "schedule",
  web: "web",
  server: "Server",
  rpc: "Rpc",
} as const;

/** Env var listing a program's RPC methods (a JSON array), set at plan. */
export const RPC_METHODS_ENV = "ALCHEMY_MODAL_RPC_METHODS";

/**
 * Env var that turns on the program's `/__rpc__/*` routes. Set only where
 * Modal authenticates every request: a class function's calls and a Server
 * behind proxy auth. A public web endpoint never serves RPC.
 */
export const RPC_SERVE_ENV = "ALCHEMY_MODAL_SERVE_RPC";

/** A streamed RPC result, as {@link ENTRYPOINT_SOURCE} returns it: its values in order. */
export const RPC_STREAM_KEY = "~alchemy/modal/rpc-stream";

export const ENTRYPOINT_SOURCE = `"""Alchemy's entrypoint for a JavaScript program on Modal (generated, do not edit)."""

import base64
import http.client
import json
import os
import socket
import subprocess
import threading
import time

import modal

_PORT = int(os.environ.get("PORT", "8000"))
_lock = threading.Lock()
_process = None


def _start():
    global _process
    with _lock:
        if _process is None or _process.poll() is not None:
            _process = subprocess.Popen(json.loads(os.environ["ALCHEMY_COMMAND"]))
        return _process


def _wait_until_listening(process, timeout=600.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"The program exited with code {process.returncode} before listening on port {_PORT}")
        try:
            socket.create_connection(("127.0.0.1", _PORT), timeout=1).close()
            return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"The program didn't listen on port {_PORT} within {timeout:.0f} seconds")


def _json_default(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    raise TypeError(f"{type(value).__name__} isn't JSON-serializable")


def _forward(path, args, kwargs):
    _wait_until_listening(_start())
    body = json.dumps({"args": list(args), "kwargs": kwargs}, default=_json_default).encode()
    headers = {"content-type": "application/json"}
    try:
        call_id = modal.current_function_call_id()
        if call_id:
            headers["x-modal-function-call-id"] = call_id
    except Exception:
        pass
    connection = http.client.HTTPConnection("127.0.0.1", _PORT)
    try:
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
    finally:
        connection.close()
    if response.status >= 400:
        raise RuntimeError(f"{path} returned {response.status}: {data.decode(errors='replace')}")
    if not data:
        return None
    if response.getheader("content-type", "").startswith("application/json"):
        return json.loads(data)
    return data.decode(errors="replace")


def _post(path, body, headers=None):
    _wait_until_listening(_start())
    connection = http.client.HTTPConnection("127.0.0.1", _PORT)
    try:
        connection.request("POST", path, body=body, headers={"content-type": "application/json", **(headers or {})})
        response = connection.getresponse()
        return response, response.read()
    finally:
        connection.close()


def _rpc(name):
    def method(self, *args, **kwargs):
        key = kwargs.pop("__alchemy_rpc_key__", None)
        if kwargs:
            raise TypeError(f"RPC method {name} takes positional arguments only")
        body = json.dumps(list(args), default=_json_default).encode()
        headers = {"x-alchemy-rpc-key": key} if isinstance(key, str) else {}
        response, data = _post("/__rpc__/" + name, body, headers)
        if response.status >= 400:
            raise RuntimeError(f"RPC method {name} returned {response.status}: {data.decode(errors='replace')}")
        if response.getheader("x-alchemy-rpc-stream") is not None:
            lines = [json.loads(line) for line in data.decode().splitlines() if line]
            return {"~alchemy/modal/rpc-stream": lines}
        return json.loads(data) if data else None

    method.__name__ = name
    return modal.method()(method)


def _rpc_enter(self):
    _wait_until_listening(_start())


Rpc = type(
    "Rpc",
    (),
    {
        "start": modal.enter()(_rpc_enter),
        **{name: _rpc(name) for name in json.loads(os.environ.get("ALCHEMY_MODAL_RPC_METHODS") or "[]")},
    },
)


def call(*args, **kwargs):
    return _forward("/__modal/call", args, kwargs)


def schedule(*args, **kwargs):
    return _forward("/__modal/schedule", args, kwargs)


def web():
    _start()


class Server:
    @modal.enter()
    def start(self):
        _wait_until_listening(_start())

    @modal.exit()
    def stop(self):
        process = _process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
`;

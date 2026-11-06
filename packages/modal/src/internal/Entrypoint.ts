/**
 * The Python module a `Modal.Function` or `Modal.Server` container imports.
 *
 * Modal boots every Function container with its Python entrypoint, which
 * imports the function's module and looks the function up by name. This
 * module is that function: it starts the bundled program (`ALCHEMY_COMMAND`,
 * from the function's env secret) once per container and hands it work as
 * HTTP on `PORT`:
 *
 * - `call` and `schedule` forward each input as `POST /__modal/call` or
 *   `POST /__modal/schedule` with a JSON body `{ "args": [...], "kwargs":
 *   {...} }`, and return the JSON response;
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
} as const;

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

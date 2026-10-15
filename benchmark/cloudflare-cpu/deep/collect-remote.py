#!/usr/bin/env python3
"""Join deep benchmark frontend requests to independently recorded receiving CPU."""

import argparse
from collections import Counter, defaultdict
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qs, urlencode, urlsplit

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cpu_collection", Path(__file__).resolve().parents[1] / "collect-cpu.py")
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)

UUID = re.compile(r"^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$")
ACTOR = re.compile(r"^[a-fA-F0-9]{64}$")
ENDPOINT = re.compile(r"^deep/(?:rpc-(?:worker|do)(?:-(?:1|20|100))?|sql(?:-noop)?|scheduled)$")


def version_of(workers):
    value = workers.get("scriptVersion")
    return value.get("id") if isinstance(value, dict) else value


def identity(event):
    metadata = event.get("$metadata", {})
    return metadata.get("requestId") or metadata.get("id")


def pages(body, endpoint, token, deadline):
    records = {}
    diagnostics = []
    seen_offsets = set()
    offset = None
    for index in range(cpu.MAX_PAGES):
        query = dict(body)
        if offset is not None:
            query.update(offset=offset, offsetDirection="next")
        rows = cpu.query(endpoint, token, query, deadline)
        diagnostics.append({"page": index + 1, "returned": len(rows)})
        for row in rows:
            key = identity(row)
            if isinstance(key, str) and key:
                # Deduplicate repeated pages/retries, never deduplicate by trace:
                # many remote invocations intentionally share one parent trace.
                records[key] = row
        if len(rows) < cpu.PAGE_LIMIT:
            return records, diagnostics, None
        offset = rows[-1].get("$metadata", {}).get("id")
        if not isinstance(offset, str) or not offset or offset in seen_offsets:
            return records, diagnostics, "Missing or repeated telemetry pagination cursor"
        seen_offsets.add(offset)
    return records, diagnostics, "Telemetry query reached the page bound"


def summary(values):
    values = sorted(values)
    if not values:
        return {"count": 0, "meanMs": None, "p50Ms": None, "p95Ms": None}
    return {
        "count": len(values), "meanMs": sum(values) / len(values),
        "p50Ms": values[math.ceil(len(values) * 0.5) - 1],
        "p95Ms": values[math.ceil(len(values) * 0.95) - 1],
    }


def inputs(args):
    prefix = args.prefix
    latency = json.loads(Path(str(prefix) + "-latency.json").read_text())
    observer_path = Path(str(prefix) + "-observer.json")
    observer = json.loads(observer_path.read_text()) if observer_path.exists() else {}
    if latency.get("harness") != "cloudflare-deep-v1":
        raise ValueError("Expected a deep/load.ts manifest")
    if observer and (observer.get("runId") != latency.get("runId") or
                     cpu.origin(observer["origin"]) != cpu.origin(latency["url"])):
        raise ValueError("Observer and latency identity differ")
    front = args.front_worker or observer.get("worker")
    remote = args.remote_worker or front
    if not all(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in (front, remote)):
        raise ValueError("Provide --front-worker (or an observer manifest) and valid Worker names")
    endpoint = args.endpoint.removeprefix("/")
    if not ENDPOINT.fullmatch(endpoint):
        raise ValueError("Endpoint must be deep/rpc-worker[-1|-20|-100], deep/rpc-do[-1|-20|-100], deep/sql, deep/sql-noop or deep/scheduled")
    workloads = [item for item in latency["workloads"] if item["endpoint"] == endpoint]
    if len(workloads) != 1:
        raise ValueError("Selected endpoint must occur exactly once in the manifest")
    workload = workloads[0]
    if not workload.get("measured", {}).get("samples"):
        raise ValueError("Selected workload has no measured requests")
    front_version = latency.get("versionBefore", {}).get("id")
    if not isinstance(front_version, str) or not UUID.fullmatch(front_version) or not latency.get("versionStable") or latency.get("versionAfter", {}).get("id") != front_version:
        raise ValueError("Frontend version must be stable and validated")
    is_sql = endpoint.startswith("deep/sql")
    is_scheduled = endpoint == "deep/scheduled"
    native_method = "drain" if is_scheduled else "noop" if endpoint == "deep/sql-noop" else "writeRead" if is_sql else None
    is_do = native_method is not None or endpoint.startswith("deep/rpc-do")
    if native_method is not None and remote != front:
        raise ValueError("Native SQL/scheduled actor belongs to the frontend Worker; remote Worker must match frontend")
    clients = []
    for phase in ("warmup", "measured"):
        for raw in workload[phase]["samples"]:
            item = {"phase": phase, "sequence": raw.get("sequence", raw.get("index")),
                    "rayId": (raw.get("cfRay") or "").split("-")[0], "valid": False}
            try:
                body = json.loads(raw.get("body") or "null")
                if not raw.get("correct") or raw.get("status") != 200 or not isinstance(body, dict):
                    raise ValueError()
                count = body["count"]
                if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                    raise ValueError()
                if body.get("ok") is not True or body.get("endpoint") != endpoint or body.get("version", {}).get("id") != front_version or body.get("checksum") != count * (count + 1) / 2:
                    raise ValueError()
                actor = body.get("actorId")
                if is_do and (not isinstance(actor, str) or not ACTOR.fullmatch(actor)):
                    raise ValueError()
                if not is_do and actor != "":
                    raise ValueError()
                if native_method is not None:
                    if count != (0 if endpoint == "deep/sql-noop" else latency["configuration"]["operations"]):
                        raise ValueError()
                    if is_sql and body.get("rows") != count:
                        raise ValueError()
                    if is_scheduled and (count not in (100, 1000) or body.get("variant") != "native-rpc-public-scheduled-events"):
                        raise ValueError()
                    remote_version, calls = front_version, 1
                else:
                    remote_version, calls = body.get("remoteVersion"), body.get("rpcCalls")
                    group_size = int(re.search(r"-(1|20|100)$", endpoint).group(1)) if re.search(r"-(1|20|100)$", endpoint) else 20
                    if count != latency["configuration"]["operations"] or calls != count or count < 1 or body.get("groupSize") != group_size:
                        raise ValueError()
                if not isinstance(remote_version, str) or not UUID.fullmatch(remote_version):
                    raise ValueError()
                item.update(valid=True, actorId=actor or None, remoteVersion=remote_version, expectedCalls=calls)
            except (ValueError, TypeError, KeyError, AttributeError):
                item["invalidReason"] = "Client response/identity/count validation failed"
            clients.append(item)
    valid = [item for item in clients if item["valid"]]
    identities = {(item["actorId"], item["remoteVersion"], item["expectedCalls"]) for item in valid}
    if len(identities) != 1:
        raise ValueError("Validated responses must have one stable remote actor/version/call count")
    actor, remote_version, calls = next(iter(identities))
    if args.actor_id and args.actor_id != actor:
        raise ValueError("--actor-id differs from validated response actor")
    if args.remote_version and args.remote_version != remote_version:
        raise ValueError("--remote-version differs from expected remote version")
    return latency, clients, front, remote, endpoint, front_version, remote_version, actor, calls, native_method, is_do


def collect(args, token, account):
    endpoint_name = args.endpoint.removeprefix("/")
    output = args.output or Path(str(args.prefix) + "-" + endpoint_name.replace("/", "-") + "-remote-cpu.json")
    if output.exists():
        raise ValueError(f"Refusing to overwrite {output}")
    latency, clients, front, remote, endpoint_name, front_version, remote_version, actor, calls, native_method, is_do = inputs(args)
    deadline = time.monotonic() + cpu.TOTAL_SECONDS
    started = cpu.now()
    run_id = latency["runId"]
    client_start, client_end = cpu.milliseconds(latency["startedAt"]), cpu.milliseconds(latency["endedAt"])
    timeframe = {"from": client_start - cpu.RETRIEVAL_PADDING_MS, "to": client_end + cpu.RETRIEVAL_PADDING_MS}
    run_marker = "?" + urlencode({"run": run_id}).replace("~", "%7E") + "&"
    filter_by = lambda key, value, operation="eq": {"key": key, "value": value, "type": "string", "operation": operation}
    def query_for(filters):
        return {"queryId": "deep-remote-cpu", "view": "events", "timeframe": timeframe,
                "limit": cpu.PAGE_LIMIT, "parameters": {"filters": filters}}
    queries = {
        "front": query_for([filter_by("$workers.scriptName", front), filter_by("$workers.eventType", "fetch"),
                            filter_by("$workers.event.request.url", run_marker, "includes"),
                            filter_by("$workers.event.request.url", "/" + endpoint_name + "?", "includes")]),
        "remote": query_for([filter_by("$workers.scriptName", remote),
                             filter_by("$workers.eventType", "jsrpc" if native_method is not None else "fetch")]),
    }
    if actor:
        queries["remote"]["parameters"]["filters"].append(filter_by("$workers.durableObjectId", actor))
    api = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query"
    sources = {"front": {}, "remote": {}}
    attempts = []
    parents = []
    matched_records = []
    final_coverage = {}
    for attempt in range(cpu.MAX_RETRIES + 1):
        diagnostic = {"attempt": attempt + 1, "startedAt": cpu.now(), "errors": []}
        attempts.append(diagnostic)
        for side in ("front", "remote"):
            try:
                rows, page_info, error = pages(queries[side], api, token, deadline)
                sources[side].update(rows)
                diagnostic[side + "Pages"] = page_info
                if error:
                    diagnostic["errors"].append(side + ": " + error)
            except (RuntimeError, OSError, ValueError, TimeoutError) as error:
                diagnostic["errors"].append(side + ": " + str(error).replace(token, "[redacted]"))

        by_ray = defaultdict(list)
        for client in clients:
            if client["rayId"]:
                by_ray[client["rayId"]].append(client)
        front_matches = defaultdict(list)
        for raw in sources["front"].values():
            parsed = cpu.sample_from_event(raw, cpu.origin(latency["url"]), run_id,
                {("/" + endpoint_name, phase): 1 for phase in ("warmup", "measured")})
            metadata, workers = raw.get("$metadata", {}), raw.get("$workers", {})
            matches = by_ray.get(metadata.get("rayId"), [])
            if parsed is None or len(matches) != 1 or version_of(workers) != front_version:
                continue
            client = matches[0]
            phase = parse_qs(urlsplit(parsed[1]["url"]).query)["phase"][0]
            if phase == client["phase"]:
                front_matches[id(client)].append((raw, parsed[1]))
        trace_owners = defaultdict(set)
        for key, matches in front_matches.items():
            for raw, _ in matches:
                trace = raw.get("$metadata", {}).get("traceId")
                if isinstance(trace, str) and trace:
                    trace_owners[trace].add(key)

        remote_by_trace = defaultdict(list)
        for raw in sources["remote"].values():
            trace = raw.get("$metadata", {}).get("traceId")
            if isinstance(trace, str) and trace:
                remote_by_trace[trace].append(raw)
        parents, matched_records = [], []
        for client in clients:
            parent = {"phase": client["phase"], "sequence": client["sequence"], "rayId": client["rayId"] or None,
                      "expectedRemoteCalls": client.get("expectedCalls", calls), "frontRequestId": None,
                      "traceId": None, "frontCpuMs": None, "frontWallMs": None,
                      "remoteEventCount": 0, "remoteEventsWithCpu": 0, "remoteRequestIds": [],
                      "remoteCpuMs": None, "remoteWallSumMs": None, "complete": False, "reasons": []}
            parents.append(parent)
            if not client["valid"]:
                parent["reasons"].append(client["invalidReason"])
                continue
            matches = front_matches.get(id(client), [])
            if len(matches) != 1:
                parent["reasons"].append("Missing or ambiguous frontend invocation")
                continue
            raw, front_sample = matches[0]
            trace = raw.get("$metadata", {}).get("traceId")
            parent.update(frontRequestId=identity(raw), traceId=trace,
                          frontCpuMs=front_sample["cpuTimeMs"], frontWallMs=front_sample["wallTimeMs"])
            if not trace or len(trace_owners[trace]) != 1:
                parent["reasons"].append("Missing or shared frontend trace ID")
                continue
            rows = remote_by_trace.get(trace, [])
            # With remote-worker defaulting to the frontend, a stateless RPC
            # query can include the parent itself. It is never receiving CPU.
            rows = [row for row in rows if identity(row) != parent["frontRequestId"]]
            parent["remoteEventCount"] = len(rows)
            parent["remoteRequestIds"] = [identity(row) for row in rows]
            if len(rows) != calls:
                parent["reasons"].append("Remote invocation count differs from validated call count")
            for row in rows:
                workers, metadata = row.get("$workers", {}), row.get("$metadata", {})
                detail = workers.get("event", {}) or {}
                reasons = []
                if version_of(workers) != remote_version:
                    reasons.append("Wrong remote version")
                if is_do and workers.get("durableObjectId") != actor:
                    reasons.append("Wrong actor")
                if not is_do and (workers.get("durableObjectId") or workers.get("executionModel") == "durableObject"):
                    reasons.append("Unexpected Durable Object invocation")
                if workers.get("outcome") != "ok":
                    reasons.append("Remote outcome is not ok")
                methods = detail.get("rpcMethods")
                rpc_count = detail.get("rpcCallCount")
                if native_method is not None:
                    if rpc_count != 1 or methods != [native_method]:
                        reasons.append("Grouped or unexpected native RPC method")
                elif rpc_count not in (None, 1):
                    reasons.append("Grouped remote HTTP event")
                value = cpu.number(workers.get("cpuTimeMs"))
                if value is None:
                    reasons.append("Missing remote CPU")
                else:
                    parent["remoteEventsWithCpu"] += 1
                record = {
                    "requestId": identity(row), "eventId": metadata.get("id"), "traceId": trace,
                    "frontRequestId": parent["frontRequestId"], "phase": client["phase"],
                    "sequence": client["sequence"], "cpuTimeMs": value,
                    "wallTimeMs": cpu.number(workers.get("wallTimeMs")),
                    "version": version_of(workers), "actorId": workers.get("durableObjectId"),
                    "timestamp": cpu.number(row.get("timestamp")),
                    "eventType": workers.get("eventType"), "rpcCallCount": cpu.number(rpc_count),
                    "rpcMethods": [item for item in (methods or []) if isinstance(item, str)] if isinstance(methods, list) else [],
                    "valid": not reasons, "reasons": reasons,
                }
                matched_records.append(record)
                parent["reasons"].extend(reasons)
            if not parent["reasons"]:
                parent["complete"] = True
                own = matched_records[-len(rows):]
                parent["remoteCpuMs"] = sum(record["cpuTimeMs"] for record in own)
                if all(record["wallTimeMs"] is not None for record in own):
                    parent["remoteWallSumMs"] = sum(record["wallTimeMs"] for record in own)

        phase_coverage = {}
        for phase in ("warmup", "measured"):
            selected = [parent for parent in parents if parent["phase"] == phase]
            complete = [parent for parent in selected if parent["complete"]]
            phase_coverage[phase] = {
                "expectedParents": len(selected), "validClientResponses": sum(client["valid"] for client in clients if client["phase"] == phase),
                "matchedFrontParents": sum(parent["frontRequestId"] is not None for parent in selected),
                "frontParentsWithCpu": sum(parent["frontCpuMs"] is not None for parent in selected),
                "expectedRemoteCalls": sum(parent["expectedRemoteCalls"] for parent in selected),
                "matchedRemoteEvents": sum(parent["remoteEventCount"] for parent in selected),
                "completeRemoteParents": len(complete), "incompleteRemoteParents": len(selected) - len(complete),
            }
        final_coverage = {"phases": phase_coverage,
                          "unmatchedRemoteEvents": len(sources["remote"]) - len(matched_records),
                          "complete": all(parent["complete"] and parent["frontCpuMs"] is not None for parent in parents)}
        diagnostic.update(endedAt=cpu.now(), coverage=final_coverage)
        if final_coverage["complete"] and not diagnostic["errors"]:
            break
        if attempt < cpu.MAX_RETRIES and deadline - time.monotonic() >= 3:
            time.sleep(3)
        else:
            break

    status = "error" if attempts[-1]["errors"] else "complete" if final_coverage["complete"] else "partial"
    measured = [parent for parent in parents if parent["phase"] == "measured"]
    result = {
        "schemaVersion": 1, "status": status, "endpoint": endpoint_name, "runId": run_id,
        "variant": latency.get("variant"), "revision": latency.get("revision"),
        "startedAt": started, "endedAt": cpu.now(), "frontWorker": front, "remoteWorker": remote,
        "frontVersion": front_version, "remoteVersion": remote_version, "actorId": actor,
        "callsPerParent": calls, "remoteKind": "native-do-rpc" if native_method is not None else "do-http" if is_do else "worker-http",
        "nativeMethod": native_method,
        "provenance": {"api": "/accounts/{account}/workers/observability/telemetry/query", "method": "POST", "queries": queries,
                       "latencyFile": str(args.prefix) + "-latency.json",
                       "clientTimeframe": {"from": client_start, "to": client_end},
                       "remoteVersionSource": "Expected deployed owning Worker version, validated frontend response" if native_method is not None else "Validated remoteVersion in every successful client response",
                       "setupExclusion": "Only selected endpoint and exact primary run ID are joined; -setup frontend traces and native prepare calls never qualify",
                       "identity": "Frontend CF-Ray matched to client sample, unique frontend traceId joined to remote invocation traceId; no timestamp attribution",
                       "maxPages": cpu.MAX_PAGES, "maxRetries": cpu.MAX_RETRIES, "totalBudgetSeconds": cpu.TOTAL_SECONDS},
        "attempts": attempts, "coverage": final_coverage,
        "measuredSummary": {
            "frontCpu": summary([parent["frontCpuMs"] for parent in measured if parent["frontCpuMs"] is not None]),
            "completeRemoteCpuPerParent": summary([parent["remoteCpuMs"] for parent in measured if parent["complete"]]),
            "remoteStatsCoverAllMeasuredParents": all(parent["complete"] for parent in measured),
        },
        "parents": parents, "remoteEvents": matched_records,
        "notes": "Frontend and receiving CPU are separate. remoteCpuMs is null unless every expected invocation is present, correctly identified, ungrouped and has CPU. Remote wall sums are not parent latency. No headers, IPs, geolocation, request payloads or unmatched remote traffic are retained.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"output": str(output), "status": status, "coverage": final_coverage, "measuredSummary": result["measuredSummary"]}))
    return status == "complete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", type=Path, help="deep load evidence prefix, without -latency.json")
    parser.add_argument("--endpoint", required=True, help="One endpoint from the deep manifest")
    parser.add_argument("--front-worker", help="Defaults to the observer manifest's Worker")
    parser.add_argument("--remote-worker", help="Defaults to the frontend Worker (correct for DO/SQL/scheduled)")
    parser.add_argument("--remote-version", help="Optional identity assertion; must match validated expected version")
    parser.add_argument("--actor-id", help="Optional assertion; must match the response's stable actor")
    parser.add_argument("--output", type=Path, help="New JSON path; defaults to PREFIX-ENDPOINT-remote-cpu.json")
    args = parser.parse_args()
    token, account = os.environ.get("CLOUDFLARE_API_TOKEN", ""), os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        parser.error("CLOUDFLARE_API_TOKEN and valid CLOUDFLARE_ACCOUNT_ID are required")
    try:
        return 0 if collect(args, token, account) else 1
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"status": "error", "error": str(error).replace(token, "[redacted]")}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

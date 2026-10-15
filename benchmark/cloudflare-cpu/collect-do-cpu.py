#!/usr/bin/env python3
"""Collect separate DO CPU by joining invocation trace IDs to benchmark HTTP calls."""

import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qs, urlsplit

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cpu_collection", Path(__file__).with_name("collect-cpu.py"))
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)


def pages(body, endpoint, token, deadline):
    rows = {}
    details = []
    offsets = set()
    offset = None
    for page in range(cpu.MAX_PAGES):
        query = dict(body)
        if offset:
            query.update(offset=offset, offsetDirection="next")
        events = cpu.query(endpoint, token, query, deadline)
        details.append({"page": page + 1, "returned": len(events)})
        for event in events:
            metadata = event.get("$metadata", {})
            key = metadata.get("requestId") or metadata.get("id")
            if isinstance(key, str):
                rows[key] = event
        if len(events) < cpu.PAGE_LIMIT:
            return list(rows.values()), details
        offset = events[-1].get("$metadata", {}).get("id")
        if not isinstance(offset, str) or offset in offsets:
            raise ValueError("Missing or repeated telemetry pagination cursor")
        offsets.add(offset)
    raise ValueError("Telemetry query reached the page bound")


def collect(prefix, token, account, deadline, actor_override):
    output = Path(str(prefix) + "-do-cpu.json")
    if output.exists():
        print(json.dumps({"output": str(output), "status": "skipped-existing"}))
        return True
    latency = json.loads(Path(str(prefix) + "-latency.json").read_text())
    observer = json.loads(Path(str(prefix) + "-observer.json").read_text())
    if latency["runId"] != observer["runId"]:
        raise ValueError("Observer and latency run IDs differ")
    worker = observer["worker"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", worker):
        raise ValueError("Invalid Worker name")
    expected_origin = cpu.origin(latency["url"])
    if cpu.origin(observer["origin"]) != expected_origin:
        raise ValueError("Observer and latency origins differ")
    rpc_workloads = [workload for workload in latency["workloads"] if workload["endpoint"] == "rpc-shape"]
    if len(rpc_workloads) != 1:
        raise ValueError("Expected exactly one rpc-shape workload")
    workload = rpc_workloads[0]
    expected = {phase: len(workload[phase]["samples"]) for phase in ("warmup", "measured")}
    method = "noop" if latency["configuration"]["operations"] == 0 else "loop"
    version = latency["versionBefore"]["id"]
    if not latency.get("versionStable") or latency["versionAfter"]["id"] != version:
        raise ValueError("Benchmark version changed during the run")
    start = cpu.milliseconds(latency["startedAt"])
    end = cpu.milliseconds(latency["endedAt"])
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query"
    base = {
        "queryId": "cpu-benchmark-do", "view": "events", "limit": cpu.PAGE_LIMIT,
        "timeframe": {"from": start - cpu.RETRIEVAL_PADDING_MS, "to": end + cpu.RETRIEVAL_PADDING_MS},
        "parameters": {"filters": [
            {"key": "$workers.scriptName", "operation": "eq", "type": "string", "value": worker},
        ]},
    }
    queries = {}
    for kind in ("fetch", "jsrpc"):
        queries[kind] = {**base, "parameters": {"filters": base["parameters"]["filters"] + [
            {"key": "$workers.eventType", "operation": "eq", "type": "string", "value": kind},
        ]}}
    host_rows = {}
    do_rows = {}
    attempts = []
    samples = []
    records = []
    coverage = {}
    actor = actor_override
    started_at = cpu.now()
    for attempt in range(cpu.MAX_RETRIES + 1):
        attempt_info = {"attempt": attempt + 1, "startedAt": cpu.now(), "error": None}
        attempts.append(attempt_info)
        try:
            for kind, destination in (("fetch", host_rows), ("jsrpc", do_rows)):
                rows, page_info = pages(queries[kind], endpoint, token, deadline)
                attempt_info[kind + "Pages"] = page_info
                for event in rows:
                    metadata = event.get("$metadata", {})
                    key = metadata.get("requestId") or metadata.get("id")
                    destination[key] = event
        except (RuntimeError, TimeoutError, OSError, ValueError) as error:
            attempt_info["error"] = str(error).replace(token, "[redacted]")

        # Trace IDs, unlike request IDs, are shared by this fixture's HTTP
        # parent and its one real DO RPC. Never assign by adjacent timestamps.
        hosts = {}
        ambiguous_traces = set()
        for event in host_rows.values():
            workers = event.get("$workers", {})
            parsed = cpu.sample_from_event(event, expected_origin, latency["runId"],
                                           {("/rpc-shape", phase): count for phase, count in expected.items()})
            trace = event.get("$metadata", {}).get("traceId")
            if parsed is None or not isinstance(trace, str) or not trace:
                continue
            if workers.get("scriptVersion", {}).get("id") != version:
                continue
            sample = parsed[1]
            sample["phase"] = parse_qs(urlsplit(sample["url"]).query)["phase"][0]
            if trace in hosts and hosts[trace]["requestId"] != sample["requestId"]:
                ambiguous_traces.add(trace)
            hosts[trace] = sample
        matching_actors = {
            event.get("$workers", {}).get("durableObjectId") for event in do_rows.values()
            if event.get("$metadata", {}).get("traceId") in hosts
        }
        matching_actors.discard(None)
        if actor is None and len(matching_actors) == 1:
            actor = next(iter(matching_actors))
        if actor is not None and not re.fullmatch(r"[a-fA-F0-9]{64}", actor):
            raise ValueError("Invalid Durable Object actor ID")

        records = []
        candidates = []
        for event in do_rows.values():
            workers = event.get("$workers", {})
            metadata = event.get("$metadata", {})
            trace = metadata.get("traceId")
            host = hosts.get(trace)
            if host is None or workers.get("durableObjectId") != actor:
                continue
            detail = workers.get("event", {})
            methods = detail.get("rpcMethods", [])
            methods = [value for value in methods if isinstance(value, str)] if isinstance(methods, list) else []
            record = {
                "cpuTimeMs": cpu.number(workers.get("cpuTimeMs")),
                "wallTimeMs": cpu.number(workers.get("wallTimeMs")),
                "timestamp": cpu.number(event.get("timestamp")),
                "version": workers.get("scriptVersion", {}).get("id"),
                "actorId": actor, "traceId": trace,
                "requestId": metadata.get("requestId") or metadata.get("id"),
                "hostRequestId": host["requestId"], "hostUrl": host["url"], "phase": host["phase"],
                "rpcMethods": methods, "rpcCallCount": cpu.number(detail.get("rpcCallCount")),
            }
            record["oneToOne"] = (
                trace not in ambiguous_traces and record["version"] == version
                and record["rpcCallCount"] == 1 and methods == [method]
            )
            records.append(record)
            if record["oneToOne"] and record["cpuTimeMs"] is not None:
                candidates.append(record)
        # Multiple DO records under one trace cannot each be one parent call.
        trace_counts = Counter(record["traceId"] for record in records)
        samples = [record for record in candidates if trace_counts[record["traceId"]] == 1]
        host_counts = Counter(host["phase"] for trace, host in hosts.items() if trace not in ambiguous_traces)
        sample_counts = Counter(record["phase"] for record in samples)
        coverage = {
            "expected": expected,
            "hostInvocations": {phase: host_counts[phase] for phase in expected},
            "oneToOneDoCpuSamples": {phase: sample_counts[phase] for phase in expected},
            "missingDoCpu": {phase: max(0, expected[phase] - sample_counts[phase]) for phase in expected},
            "matchedDoRecords": len(records),
            "unmatchedDoRecords": len(do_rows) - len(records),
            "ambiguousHostTraceIds": len(ambiguous_traces),
            "matchingActors": sorted(matching_actors),
            "multiOrZeroCallRecords": sum(record["rpcCallCount"] != 1 for record in records),
            "complete": actor is not None and len(matching_actors) == 1
                and not ambiguous_traces and all(sample_counts[phase] == expected[phase] for phase in expected),
        }
        attempt_info.update(endedAt=cpu.now(), coverage=coverage)
        if coverage["complete"] and attempt_info["error"] is None:
            break
        if attempt < cpu.MAX_RETRIES and deadline - time.monotonic() >= 3:
            time.sleep(3)
        else:
            break
    status = "complete" if coverage.get("complete") and attempts[-1]["error"] is None else "partial"
    if attempts[-1]["error"]:
        status = "error"
    result = {
        "schemaVersion": 1, "status": status, "worker": worker, "actorId": actor,
        "version": version, "runId": latency["runId"], "variant": latency.get("variant"),
        "revision": latency.get("revision"), "startedAt": started_at, "endedAt": cpu.now(),
        "provenance": {
            "api": "/accounts/{account}/workers/observability/telemetry/query", "method": "POST",
            "queries": queries, "clientTimeframe": {"from": start, "to": end},
            "rpcMeasuredTimeframe": {"from": cpu.milliseconds(workload["measured"]["startedAt"]),
                                     "to": cpu.milliseconds(workload["measured"]["endedAt"])},
            "retrievalPaddingMs": cpu.RETRIEVAL_PADDING_MS,
            "attribution": "Shared traceId with a unique benchmark HTTP parent, exact run/origin/phase, stable actor and version, one matching RPC method and rpcCallCount=1",
            "scope": "Durable Object CPU only. This excludes Worker CPU; do not infer actor CPU from host CPU or client latency.",
        },
        "attempts": attempts, "coverage": coverage,
        "samples": sorted(samples, key=lambda item: (item["timestamp"] or 0, item["requestId"])),
        "matchedRecords": sorted(records, key=lambda item: (item["timestamp"] or 0, item["requestId"])),
        "notes": "Only samples are safe for per-call CPU statistics. matchedRecords retain multi/zero-call records for audit; their CPU is never divided or assigned to individual calls. Missing or sampled telemetry remains incomplete. No request headers, IPs, or geolocation are retained.",
    }
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"output": str(output), "status": status, "coverage": coverage}))
    return status == "complete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", type=Path, nargs="+")
    parser.add_argument("--actor-id", help="Require this stable actor (otherwise infer only if exactly one matches)")
    args = parser.parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        parser.error("CLOUDFLARE_API_TOKEN and valid CLOUDFLARE_ACCOUNT_ID are required")
    deadline = time.monotonic() + cpu.TOTAL_SECONDS
    success = True
    for prefix in args.prefix:
        try:
            success = collect(prefix, token, account, deadline, args.actor_id) and success
        except (KeyError, TypeError, ValueError, OSError) as error:
            print(json.dumps({"prefix": str(prefix), "error": str(error).replace(token, "[redacted]")}), file=sys.stderr)
            success = False
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())

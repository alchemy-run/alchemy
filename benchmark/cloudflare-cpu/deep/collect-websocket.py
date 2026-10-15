#!/usr/bin/env python3
"""Inspect isolated WebSocket actor CPU; require a verified event-count model for totals."""

import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cpu_collection", Path(__file__).resolve().parents[1] / "collect-cpu.py")
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)
WEBSOCKET_EVENT_TYPES = {"hibernatableWebSocket", "websocket"}


def version(workers):
    value = workers.get("scriptVersion")
    return value.get("id") if isinstance(value, dict) else value


def shape(value, depth=0):
    """Keep field names/types for inspection, never payload/header values."""
    if depth >= 4:
        return type(value).__name__
    if isinstance(value, dict):
        return {key: shape(child, depth + 1) for key, child in sorted(value.items())
                if key.lower() not in {"headers", "cf", "request", "data", "message", "payload", "reason"}}
    if isinstance(value, list):
        return {"type": "array", "length": len(value), "firstType": type(value[0]).__name__ if value else None}
    return type(value).__name__


def subtype(event):
    if not isinstance(event, dict):
        return "unknown"
    known = {"message": "message", "close": "close", "error": "error", "open": "open",
             "websocketmessage": "message", "websocketclose": "close", "websocketerror": "error"}
    for key, value in event.items():
        normalized = re.sub(r"[^a-z]", "", key.lower())
        if normalized in ("websocketmessage", "websocketclose", "websocketerror"):
            return known[normalized]
        if normalized in ("type", "kind", "eventtype", "websocketeventtype", "websockettype") and isinstance(value, str):
            normalized_value = re.sub(r"[^a-z]", "", value.lower())
            if normalized_value in known:
                return known[normalized_value]
        if isinstance(value, dict):
            nested = subtype(value)
            if nested != "unknown":
                return nested
    return "unknown"


def pages(body, endpoint, token, deadline):
    rows = {}
    diagnostics = []
    offsets = set()
    offset = None
    for index in range(cpu.MAX_PAGES):
        query = dict(body)
        if offset:
            query.update(offset=offset, offsetDirection="next")
        events = cpu.query(endpoint, token, query, deadline)
        diagnostics.append({"page": index + 1, "returned": len(events)})
        for event in events:
            metadata = event.get("$metadata", {})
            event_id = metadata.get("id")
            if isinstance(event_id, str):
                # Observed metadata IDs can collide across distinct native
                # request IDs; console and invocation rows also share IDs.
                # Preserve those rows here, then deduplicate native CPU by
                # its authoritative requestId during analysis.
                rows[(event_id, metadata.get("requestId"), metadata.get("type"))] = event
        if len(events) < cpu.PAGE_LIMIT:
            return rows, diagnostics, None
        offset = events[-1].get("$metadata", {}).get("id")
        if not isinstance(offset, str) or offset in offsets:
            return rows, diagnostics, "Missing or repeated telemetry pagination cursor"
        offsets.add(offset)
    return rows, diagnostics, "Telemetry query reached the page bound"


def marker_of(row, tokens):
    raw = row.get("$metadata", {}).get("message")
    candidates = [row, row.get("source")]
    if isinstance(raw, str):
        try:
            candidates.append(json.loads(raw))
        except ValueError:
            pass
    # Structured console JSON can live under source or at the top level;
    # older log shapes keep the same JSON string in $metadata.message.
    marker = next((candidate for candidate in candidates if isinstance(candidate, dict)
                   and candidate.get("marker") in ("cpu-websocket-begin", "cpu-websocket-end")
                   and candidate.get("runToken") in tokens), None)
    if marker is None:
        return None
    allowed = ("marker", "runToken", "count", "metadataBytes", "actorId", "versionId", "connectionId",
               "calls", "checksum", "held", "metadataPreserved")
    result = {key: marker[key] for key in allowed if key in marker}
    metadata = row.get("$metadata", {})
    result.update(requestId=metadata.get("requestId"), eventId=metadata.get("id"))
    return result


def analyze(trial, rows, expected_version, worker, expected_close, namespace):
    sessions = [session for session in (trial.get("warmup"), trial.get("measured")) if session]
    tokens = {session.get("runToken") for session in sessions}
    actors = {session.get("actorId") for session in sessions}
    reasons = []
    actor = next(iter(actors)) if len(actors) == 1 else None
    if not trial.get("correct") or not actor or not re.fullmatch(r"[a-f0-9]{64}", actor):
        reasons.append("Invalid trial or inconsistent actor identity")
    if (trial.get("close") or {}).get("code") != 1000:
        reasons.append("Client did not confirm normal socket close")
    ledger = []
    for session in sessions:
        count = session.get("count")
        first, last = session.get("firstFrameIndex"), session.get("lastFrameIndex")
        frames = trial.get("frames", [])[first:last + 1] if isinstance(first, int) and isinstance(last, int) else []
        outgoing = [frame for frame in frames if frame.get("direction") == "client"]
        incoming = [frame for frame in frames if frame.get("direction") == "server"]
        request_ids = [frame.get("message", {}).get("id") for frame in outgoing
                       if frame.get("message", {}).get("_tag") == "Request"]
        valid = (isinstance(count, int) and count in (100, 1000) and session.get("correct") is True
                 and session.get("versionId") == expected_version and len(outgoing) == count + 5
                 and len(incoming) == count + 5 and len(request_ids) == count + 4
                 and request_ids == session.get("requestIds")
                 and session.get("clientFrames") == count + 5
                 and session.get("expectedWebSocketMessageEvents") == count + 5)
        if not valid:
            reasons.append("Client frame ledger validation failed")
        ledger.append({"phase": session.get("phase"), "runToken": session.get("runToken"),
                       "unaryCalls": count, "requestIds": request_ids, "expectedMessageEvents": (count + 5) if isinstance(count, int) else None,
                       "clientFrames": len(outgoing), "serverFrames": len(incoming), "valid": valid})
    if not sessions or not trial.get("measured"):
        reasons.append("Missing measured session")
    expected_messages = sum(item["expectedMessageEvents"] or 0 for item in ledger)
    total_client = sum(frame.get("direction") == "client" for frame in trial.get("frames", []))
    if total_client != expected_messages:
        reasons.append("Trailing or missing client frames outside session ledgers")

    native = {}
    upgrades = {}
    markers = {}
    event_shapes = Counter()
    duplicate_native_rows = 0
    for row in rows.values():
        workers, metadata = row.get("$workers", {}), row.get("$metadata", {})
        if workers.get("durableObjectId") != actor or workers.get("scriptName") != worker:
            continue
        marker = marker_of(row, tokens)
        if marker:
            markers[(marker["marker"], marker["runToken"])] = marker
        event_type = workers.get("eventType")
        detail = workers.get("event", {})
        event_shapes[(event_type, json.dumps(shape(detail), sort_keys=True))] += 1
        request_id = metadata.get("requestId")
        # Console marker rows do not each represent another native invocation.
        is_invocation = metadata.get("type") == "cf-worker-event"
        if not is_invocation or not isinstance(request_id, str):
            continue
        record = {"requestId": request_id, "eventId": metadata.get("id"),
                  "timestamp": cpu.number(row.get("timestamp")), "eventType": event_type,
                  "subtype": subtype(detail), "version": version(workers), "actorId": actor,
                  "cpuTimeMs": cpu.number(workers.get("cpuTimeMs")),
                  "wallTimeMs": cpu.number(workers.get("wallTimeMs")),
                  "outcome": workers.get("outcome"), "truncated": workers.get("truncated"),
                  "closeCode": detail.get("code") if isinstance(detail, dict) and subtype(detail) == "close" else None,
                  "closeWasClean": detail.get("wasClean") if isinstance(detail, dict) and subtype(detail) == "close" else None,
                  "httpStatus": detail.get("response", {}).get("status") if isinstance(detail, dict) and isinstance(detail.get("response"), dict) else None,
                  "eventShape": shape(detail)}
        target = native if event_type in WEBSOCKET_EVENT_TYPES else upgrades if event_type == "fetch" else None
        if target is None:
            continue
        if request_id in target:
            duplicate_native_rows += event_type in WEBSOCKET_EVENT_TYPES
            if target[request_id]["cpuTimeMs"] is not None and record["cpuTimeMs"] is None:
                continue
        target[request_id] = record

    marker_checks = []
    for session in sessions:
        pair = []
        for tag in ("cpu-websocket-begin", "cpu-websocket-end"):
            found = markers.get((tag, session.get("runToken")))
            valid = found is not None and all(found.get(key) == session.get(key) for key in
                ("runToken", "count", "metadataBytes", "actorId", "versionId", "connectionId"))
            valid = valid and found.get("requestId") in native
            if tag.endswith("end") and found:
                valid = valid and found.get("calls") == session.get("count") and found.get("held") is False and found.get("metadataPreserved") is True
            pair.append({"marker": tag, "valid": bool(valid), "requestId": found.get("requestId") if found else None})
        if not all(item["valid"] for item in pair) or pair[0]["requestId"] == pair[1]["requestId"]:
            reasons.append("Begin/end markers are missing, inconsistent, or not distinct native invocations")
        marker_checks.append({"runToken": session.get("runToken"), "markers": pair})

    types = Counter(record["subtype"] for record in native.values())
    model_source = "operator-confirmed close-event count" if expected_close is not None else None
    if expected_close is None and native and types["close"] == 1 and types["unknown"] == 0 and types["open"] == 0 and types["error"] == 0:
        expected_close = 1
        model_source = "explicit native message/close subtype fields"
    if expected_close is None:
        reasons.append("Native message/close event-count model is unverified")
    elif len(native) != expected_messages + expected_close:
        reasons.append("Native invocation count differs from client message ledger plus close events")
    if types["open"] or types["error"]:
        reasons.append("Native WebSocket open/error events contradict the message/close event-count model")
    # An operator-supplied count can fill missing subtype information, but cannot
    # override event types reported by the platform.
    if expected_close is not None and (
        types["message"] > expected_messages or types["close"] > expected_close
        or (types["unknown"] == 0 and (types["message"] != expected_messages or types["close"] != expected_close))
    ):
        reasons.append("Message/close subtype counts do not match the ledger")
    if any(record["subtype"] == "close" and (record["closeCode"] != 1000 or record["closeWasClean"] is not True) for record in native.values()):
        reasons.append("Native socket close was not clean code 1000")
    if any(record["version"] != expected_version for record in native.values()):
        reasons.append("Native invocation version differs from validated socket version")
    if any(record["outcome"] != "ok" for record in native.values()):
        reasons.append("Native invocation outcome is not ok")
    if any(record["cpuTimeMs"] is None for record in native.values()):
        reasons.append("Native CPU is missing")
    if any(record["truncated"] is True for record in native.values()):
        reasons.append("Native event metadata was truncated")
    complete = not reasons
    # The deployed upgrade event exposes only its path, not a response status.
    # A valid completed client trial proves that handshake opened. Preserve a
    # missing status as null; never manufacture a 101 in the evidence.
    upgrade_complete = trial.get("correct") is True and len(upgrades) == 1 and all(
        record["version"] == expected_version and record["cpuTimeMs"] is not None
        and record["outcome"] == "ok" and record["httpStatus"] in (None, 101)
        for record in upgrades.values())
    websocket_cpu = sum(record["cpuTimeMs"] for record in native.values()) if complete else None
    upgrade_cpu = sum(record["cpuTimeMs"] for record in upgrades.values()) if upgrade_complete else None
    return {
        "trialIndex": trial["trialIndex"], "metadataBytes": trial["metadataBytes"],
        "actorName": trial["actorName"], "actorId": actor, "namespaceId": namespace,
        "wholeTrialWindow": {"from": trial["startedAt"], "to": trial["endedAt"]},
        "scope": "Whole isolated actor trial, including all control frames, optional warmup and close; no slicing by client timestamps",
        "upgradeValidation": "Client's completed protocol trial proves handshake success; one actor-matched, version-matched, successful fetch event is required. Unreported HTTP status remains null.",
        "ledger": ledger, "markerChecks": marker_checks,
        "coverage": {"complete": complete, "reasons": sorted(set(reasons)),
                     "expectedMessageEvents": expected_messages, "expectedCloseEvents": expected_close,
                     "eventCountModelSource": model_source, "nativeInvocations": len(native),
                     "nativeWithCpu": sum(record["cpuTimeMs"] is not None for record in native.values()),
                     "subtypes": dict(types), "duplicateNativeRows": duplicate_native_rows,
                     "upgradeInvocations": len(upgrades), "upgradeComplete": upgrade_complete},
        "cpu": {"websocketEventsMs": websocket_cpu, "upgradeMs": upgrade_cpu,
                "wholeActorIncludingUpgradeMs": websocket_cpu + upgrade_cpu if complete and upgrade_complete else None,
                "includesWarmup": bool(trial.get("warmup"))},
        "nativeEvents": sorted(native.values(), key=lambda item: (item["timestamp"] or 0, item["requestId"])),
        "upgradeEvents": list(upgrades.values()),
        "eventShapes": [{"eventType": key[0], "shape": json.loads(key[1]), "rows": count} for key, count in event_shapes.items()],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="websocket-load JSON, or prefix with -latency.json")
    parser.add_argument("--worker", required=True)
    parser.add_argument("--namespace-id", help="Deployment namespace ID for provenance; actor IDs filter the API")
    parser.add_argument("--expected-close-events", type=int, choices=(0, 1),
                        help="Confirm only after inspecting the native event model; default remains provisional if subtypes are absent")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    path = args.manifest if args.manifest.exists() else Path(str(args.manifest) + "-latency.json")
    output = args.output or path.with_name(path.stem.removesuffix("-latency") + "-websocket-cpu.json")
    if output.exists():
        raise ValueError(f"Refusing to overwrite {output}")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.worker):
        raise ValueError("Invalid Worker name")
    if args.namespace_id and not re.fullmatch(r"[a-fA-F0-9]{32}", args.namespace_id):
        raise ValueError("Invalid namespace ID")
    manifest = json.loads(path.read_text())
    if manifest.get("harness") != "cloudflare-websocket-v1" or not manifest.get("complete") or not manifest.get("versionStable"):
        raise ValueError("Expected a completed, version-stable websocket-load manifest")
    token, account = os.environ.get("CLOUDFLARE_API_TOKEN", ""), os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise ValueError("CLOUDFLARE_API_TOKEN and valid CLOUDFLARE_ACCOUNT_ID are required")
    deadline = time.monotonic() + cpu.TOTAL_SECONDS
    api = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query"
    analyses, provenance = [], []
    actor_counts = Counter(trial.get("measured", {}).get("actorId") for trial in manifest["trials"] if trial.get("measured"))
    for trial in manifest["trials"]:
        actor = trial.get("measured", {}).get("actorId") if trial.get("measured") else None
        if not actor or not re.fullmatch(r"[a-f0-9]{64}", actor):
            analyses.append({"trialIndex": trial["trialIndex"], "coverage": {"complete": False, "reasons": ["Missing valid trial actor"]}})
            continue
        query = {"queryId": "deep-websocket-cpu", "view": "events", "limit": cpu.PAGE_LIMIT,
                 "timeframe": {"from": cpu.milliseconds(trial["startedAt"]) - cpu.RETRIEVAL_PADDING_MS,
                               "to": cpu.milliseconds(trial["endedAt"]) + cpu.RETRIEVAL_PADDING_MS},
                 "parameters": {"filters": [
                     {"key": "$workers.scriptName", "operation": "eq", "type": "string", "value": args.worker},
                     {"key": "$workers.durableObjectId", "operation": "eq", "type": "string", "value": actor},
                 ]}}
        sources, attempts = {}, []
        for attempt in range(cpu.MAX_RETRIES + 1):
            diagnostic = {"attempt": attempt + 1, "at": cpu.now(), "error": None}
            attempts.append(diagnostic)
            try:
                rows, page_info, error = pages(query, api, token, deadline)
                sources.update(rows)
                diagnostic.update(pages=page_info, error=error)
            except (RuntimeError, OSError, ValueError, TimeoutError) as error:
                diagnostic["error"] = str(error).replace(token, "[redacted]")
            analysis = analyze(trial, sources, manifest["versionBefore"], args.worker, args.expected_close_events, args.namespace_id)
            if actor_counts[actor] != 1:
                analysis["coverage"]["reasons"].append("Actor reused by multiple trials")
                analysis["coverage"]["complete"] = False
                analysis["cpu"] = {key: None for key in analysis["cpu"]}
            if diagnostic["error"]:
                analysis["coverage"]["reasons"].append(diagnostic["error"])
                analysis["coverage"]["complete"] = False
                analysis["cpu"]["websocketEventsMs"] = None
                analysis["cpu"]["wholeActorIncludingUpgradeMs"] = None
            diagnostic["coverage"] = analysis["coverage"]
            if analysis["coverage"]["complete"]:
                break
            if attempt < cpu.MAX_RETRIES and deadline - time.monotonic() >= 3:
                time.sleep(3)
            else:
                break
        analyses.append(analysis)
        provenance.append({"actorId": actor, "query": query, "attempts": attempts})
    complete = manifest.get("allCorrect") and all(trial["coverage"]["complete"] for trial in analyses)
    result = {"schemaVersion": 1, "status": "complete" if complete else "provisional-or-partial",
              "worker": args.worker, "namespaceId": args.namespace_id, "version": manifest["versionBefore"],
              "runId": manifest["runId"], "variant": manifest.get("variant"), "revision": manifest.get("revision"),
              "manifest": str(path), "trials": analyses, "provenance": provenance,
              "notes": "Only cf-worker-event rows with eventType=hibernatableWebSocket (or legacy websocket) contribute websocket CPU; structured console marker rows never add invocations. Fetch upgrade CPU is separate. Unknown message/close event models stay provisional. All control frames and close count toward whole-trial totals; missing CPU is never imputed. Field-shape inspection excludes payloads, headers and client location."}
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"output": str(output), "status": result["status"],
                      "trials": [{"actorId": trial.get("actorId"), "coverage": trial["coverage"], "cpu": trial.get("cpu")} for trial in analyses]}))
    return 0 if complete else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError) as error:
        token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        message = str(error).replace(token, "[redacted]") if token else str(error)
        print(json.dumps({"status": "error", "error": message}), file=sys.stderr)
        sys.exit(1)

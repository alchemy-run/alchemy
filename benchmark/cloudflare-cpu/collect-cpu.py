#!/usr/bin/env python3
"""Collect stored invocation CPU for load.ts runs without retaining request metadata."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


PAGE_LIMIT = 1000
MAX_PAGES = 30
MAX_RETRIES = 3
TOTAL_SECONDS = 210
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
RETRIEVAL_PADDING_MS = 10_000


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


OPENER = build_opener(NoRedirect)


def now():
    return datetime.now(timezone.utc).isoformat()


def milliseconds(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Benchmark timestamps must include a timezone")
    return math.floor(parsed.timestamp() * 1000)


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def origin(value):
    url = urlsplit(value)
    if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password:
        raise ValueError("Benchmark URL must have an HTTP(S) origin without credentials")
    return url.scheme.lower(), url.hostname.lower(), url.port or (443 if url.scheme == "https" else 80)


def expected_counts(latency):
    counts = Counter()
    for phase in ("before", "after"):
        if latency.get("health", {}).get(phase):
            counts[("/health", phase)] += 1
    for workload in latency.get("workloads", []):
        path = "/" + workload["endpoint"]
        for phase in ("warmup", "measured"):
            counts[(path, phase)] += len(workload.get(phase, {}).get("samples", []))
    return counts


def query(endpoint, token, body, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Collector exhausted its total time budget")
    request = Request(endpoint, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    try:
        with OPENER.open(request, timeout=min(15, remaining)) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise ValueError("Telemetry response exceeded 64 MiB")
        result = json.loads(payload)
        if not isinstance(result, dict) or result.get("success") is False:
            raise ValueError("Cloudflare telemetry query returned an unsuccessful envelope")
        events = result.get("result", {}).get("events", {}).get("events")
        if not isinstance(events, list):
            raise ValueError("Cloudflare telemetry response has no events array")
        return events
    except HTTPError as error:
        # Report API error codes, not a potentially sensitive raw response body.
        codes = []
        try:
            body = json.loads(error.read(8192))
            codes = [item.get("code") for item in body.get("errors", []) if isinstance(item, dict)]
        except (ValueError, AttributeError):
            pass
        raise RuntimeError(f"Cloudflare telemetry HTTP {error.code}; error codes {codes}") from None
    except URLError:
        raise RuntimeError("Cloudflare telemetry network request failed") from None


def sample_from_event(event, expected_origin, run_id, expected):
    if not isinstance(event, dict):
        return None
    workers = event.get("$workers", {})
    metadata = event.get("$metadata", {})
    if not isinstance(workers, dict) or not isinstance(metadata, dict):
        return None
    request = workers.get("event", {}).get("request", {})
    if not isinstance(request, dict) or not isinstance(request.get("url"), str):
        return None
    url = request["url"]
    try:
        parts = urlsplit(url)
        params = parse_qs(parts.query, keep_blank_values=True)
        if origin(url) != expected_origin or params.get("run") != [run_id]:
            return None
        if set(params) - {"run", "phase", "count"} or parts.fragment:
            return None
        phase = params.get("phase", [])
        if len(phase) != 1 or (parts.path, phase[0]) not in expected:
            return None
    except ValueError:
        return None
    request_id = metadata.get("requestId")
    event_id = metadata.get("id")
    if isinstance(request_id, str) and request_id:
        key = "request:" + request_id
    elif isinstance(event_id, str) and event_id:
        request_id = event_id
        key = "event:" + event_id
    else:
        return None  # Cannot deduplicate safely; never invent an invocation identity.
    version = workers.get("scriptVersion")
    if isinstance(version, dict):
        version = version.get("id")
    if not isinstance(version, str):
        version = None
    cf = request.get("cf", {})
    colo = cf.get("colo") if isinstance(cf, dict) else None
    if not isinstance(colo, str) or not re.fullmatch(r"[A-Z0-9]{3,8}", colo):
        colo = None
    return key, {
        "cpuTimeMs": number(workers.get("cpuTimeMs")),
        "outcome": workers.get("outcome"),
        "wallTimeMs": number(workers.get("wallTimeMs")),
        "version": version,
        "requestId": request_id,
        "url": url,
        "timestamp": number(event.get("timestamp")),
        "colo": colo,
    }


def manifest_version(latency):
    before = latency.get("versionBefore")
    after = latency.get("versionAfter")
    version = before.get("id") if isinstance(before, dict) else None
    if (not isinstance(version, str) or not version
            or latency.get("versionStable") is not True
            or not isinstance(after, dict) or after.get("id") != version):
        raise ValueError("Benchmark manifest must identify one stable before/after version")
    return version


def sample_versions(sample):
    # Earlier schema versions stored only `version`. Retain every non-null
    # version seen for a deduplicated invocation so later rows cannot hide a
    # conflicting deployment identity.
    return set(sample.get("observedVersions", [])) | ({sample["version"]} if sample.get("version") else set())


def sample_matches_version(sample, expected_version):
    return (sample_versions(sample) == {expected_version}
            and (sample.get("cpuTimeMs") is None
                 or sample.get("cpuVersion", sample.get("version")) == expected_version))


def merge_sample(existing, sample):
    merged = dict(sample) if existing is None else {
        field: sample.get(field) if sample.get(field) is not None else existing.get(field)
        for field in existing.keys() | sample.keys()
    }
    merged["observedVersions"] = sorted(sample_versions(sample) | (sample_versions(existing) if existing else set()))
    if sample["cpuTimeMs"] is not None:
        # A version-only row cannot lend its identity to unversioned CPU.
        merged["cpuVersion"] = sample["version"]
    elif existing is not None:
        merged["cpuVersion"] = existing.get("cpuVersion", existing.get("version"))
    return merged


def coverage(samples, expected, expected_total, expected_version):
    observed = Counter()
    with_cpu = Counter()
    mismatched_version = Counter()
    missing_version = Counter()
    version_counts = Counter()
    for sample in samples.values():
        parts = urlsplit(sample["url"])
        phase = parse_qs(parts.query)["phase"][0]
        key = parts.path, phase
        observed[key] += 1
        versions = sample_versions(sample)
        version_counts.update(versions)
        if versions - {expected_version}:
            mismatched_version[key] += 1
        if not versions or (sample["cpuTimeMs"] is not None and sample.get("cpuVersion", sample.get("version")) is None):
            missing_version[key] += 1
        if sample["cpuTimeMs"] is not None and sample_matches_version(sample, expected_version):
            with_cpu[key] += 1
    groups = [{
        "path": key[0], "phase": key[1], "expected": count,
        "observed": observed[key], "withCpu": with_cpu[key],
        "mismatchedVersion": mismatched_version[key], "missingVersion": missing_version[key],
        "missingEvents": max(0, count - observed[key]),
        "missingCpu": max(0, count - with_cpu[key]),
        "excessEvents": max(0, observed[key] - count),
    } for key, count in sorted(expected.items())]
    cpu_count = sum(sample["cpuTimeMs"] is not None and sample_matches_version(sample, expected_version) for sample in samples.values())
    return {
        "expectedVersion": expected_version,
        "observedVersions": dict(sorted(version_counts.items())),
        "mismatchedVersionInvocations": sum(mismatched_version.values()),
        "missingVersionInvocations": sum(missing_version.values()),
        "matchingVersionInvocations": sum(sample_matches_version(sample, expected_version) for sample in samples.values()),
        "expectedTotalRequests": expected_total,
        "expectedFromRawLatencySamples": sum(expected.values()),
        "observedInvocations": len(samples), "invocationsWithCpu": cpu_count,
        "invocationsWithWall": sum(sample["wallTimeMs"] is not None and sample_matches_version(sample, expected_version) for sample in samples.values()),
        "missingEvents": max(0, expected_total - len(samples)),
        "missingCpu": max(0, expected_total - cpu_count),
        "complete": len(samples) == expected_total and cpu_count == expected_total
        and sum(expected.values()) == expected_total
        and not mismatched_version and not missing_version
        and all(group["missingCpu"] == 0 and group["excessEvents"] == 0 for group in groups),
        "groups": groups,
    }


def collect(prefix, token, account, deadline):
    output = Path(str(prefix) + "-cpu.json")
    latency_path = Path(str(prefix) + "-latency.json")
    observer_path = Path(str(prefix) + "-observer.json")
    latency = json.loads(latency_path.read_text())
    observer = json.loads(observer_path.read_text())
    worker = observer["worker"]
    if not isinstance(worker, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", worker):
        raise ValueError("Observer has an invalid Worker name")
    run_id = latency["runId"]
    if not isinstance(run_id, str) or observer.get("runId") != run_id:
        raise ValueError("Latency and observer run IDs differ")
    expected_origin = origin(latency["url"])
    if origin(observer["origin"]) != expected_origin:
        raise ValueError("Latency and observer origins differ")
    client_start = milliseconds(latency["startedAt"])
    client_end = milliseconds(latency["endedAt"])
    if client_end <= client_start:
        raise ValueError("Invalid benchmark time window")
    # Client timestamps and Cloudflare invocation timestamps are different
    # clock domains. Run/phase/origin filters isolate this run within the wider
    # retrieval window; do not filter samples back down to the client window.
    start = client_start - RETRIEVAL_PADDING_MS
    end = client_end + RETRIEVAL_PADDING_MS
    expected_total = latency["totalRequests"]
    if not isinstance(expected_total, int) or isinstance(expected_total, bool) or expected_total < 1:
        raise ValueError("Invalid expected request count")
    expected = expected_counts(latency)
    expected_version = manifest_version(latency)
    if output.exists():
        retained = json.loads(output.read_text())
        retained_samples = {str(index): sample for index, sample in enumerate(retained["samples"])}
        retained_coverage = coverage(retained_samples, expected, expected_total, expected_version)
        valid = retained.get("status") == "complete" and retained_coverage["complete"]
        print(json.dumps({"output": str(output), "status": "skipped-existing" if valid else "invalid-existing", "coverage": retained_coverage}))
        return valid
    # load.ts inserts run first, then phase. Filter at the API as well as
    # locally so traced Workers do not page through every emitted span or
    # their Durable Object events. URLSearchParams encodes '~' unlike urllib.
    run_marker = "?" + urlencode({"run": run_id}).replace("~", "%7E") + "&"
    base_query = {
        "queryId": "cpu-benchmark", "view": "events",
        "timeframe": {"from": start, "to": end}, "limit": PAGE_LIMIT,
        "parameters": {"filters": [
            {"key": "$workers.scriptName", "operation": "eq", "type": "string", "value": worker},
            {"key": "$workers.eventType", "operation": "eq", "type": "string", "value": "fetch"},
            {"key": "$workers.event.request.url", "operation": "includes", "type": "string", "value": run_marker},
        ]},
    }
    endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query"
    started = now()
    samples = {}
    attempts = []
    result_coverage = coverage(samples, expected, expected_total, expected_version)
    for attempt in range(MAX_RETRIES + 1):
        entry = {"attempt": attempt + 1, "startedAt": now(), "pages": [], "error": None}
        attempts.append(entry)
        offset = None
        seen_offsets = set()
        try:
            for page in range(MAX_PAGES):
                body = dict(base_query)
                if offset is not None:
                    body["offset"] = offset
                    body["offsetDirection"] = "next"
                events = query(endpoint, token, body, deadline)
                matched = 0
                for event in events:
                    parsed = sample_from_event(event, expected_origin, run_id, expected)
                    if parsed is None:
                        continue
                    key, sample = parsed
                    matched += 1
                    samples[key] = merge_sample(samples.get(key), sample)
                entry["pages"].append({"page": page + 1, "returned": len(events), "matched": matched})
                if len(events) < PAGE_LIMIT:
                    break
                last = events[-1].get("$metadata", {}) if isinstance(events[-1], dict) else {}
                offset = last.get("id")
                if not isinstance(offset, str) or not offset or offset in seen_offsets:
                    raise ValueError("Telemetry pagination cursor missing or repeated")
                seen_offsets.add(offset)
            else:
                raise ValueError("Telemetry query reached the 30-page bound")
        except (RuntimeError, TimeoutError, ValueError, OSError) as error:
            # No raw event, credentials, HTTP headers, or request body in errors.
            entry["error"] = str(error).replace(token, "[redacted]")
        entry["endedAt"] = now()
        result_coverage = coverage(samples, expected, expected_total, expected_version)
        entry["coverage"] = result_coverage
        if result_coverage["complete"] and entry["error"] is None:
            break
        if attempt < MAX_RETRIES and deadline - time.monotonic() >= 3:
            time.sleep(3)
        else:
            break
    failed = any(entry["error"] for entry in attempts[-1:])
    invalid_version = result_coverage["mismatchedVersionInvocations"] or result_coverage["missingVersionInvocations"]
    status = "invalid" if invalid_version else "complete" if result_coverage["complete"] and not failed else "error" if failed else "partial"
    result = {
        "schemaVersion": 2, "status": status, "worker": worker, "runId": run_id,
        "version": expected_version,
        "variant": latency.get("variant"), "revision": latency.get("revision"),
        "startedAt": started, "endedAt": now(),
        "provenance": {
            "api": "/accounts/{account}/workers/observability/telemetry/query",
            "method": "POST", "query": base_query,
            "clientTimeframe": {"from": client_start, "to": client_end},
            "retrievalTimeframe": {"from": start, "to": end},
            "retrievalPaddingMs": RETRIEVAL_PADDING_MS,
            "clockDomains": "Client wall clock and provider invocation timestamps may differ; exact origin/run/phase matching determines membership.",
            "latencyFile": str(latency_path), "observerFile": str(observer_path),
            "maxPagesPerAttempt": MAX_PAGES, "maxRetries": MAX_RETRIES,
            "retryDelaySeconds": 3, "collectorTotalBudgetSeconds": TOTAL_SECONDS,
            "deduplication": "$metadata.requestId, falling back to $metadata.id",
            "versionValidation": "Every invocation must match the stable manifest version; conflicting duplicate versions are retained and invalidate coverage.",
        },
        "attempts": attempts, "coverage": result_coverage,
        "samples": sorted(samples.values(), key=lambda sample: (sample["timestamp"] or 0, sample["requestId"])),
        "notes": "CPU and wall times are provider-reported milliseconds. Null values are absent or invalid, never inferred from latency. Wrong/missing versions invalidate the cohort and never contribute accepted CPU. Only allowlisted fields survive; no request headers, IPs, or geolocation are retained.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({"output": str(output), "status": status, "coverage": result_coverage}))
    return status == "complete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", type=Path, nargs="+", help="Evidence prefix (without -latency.json)")
    args = parser.parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        parser.error("CLOUDFLARE_API_TOKEN and valid CLOUDFLARE_ACCOUNT_ID are required")
    deadline = time.monotonic() + TOTAL_SECONDS
    successful = True
    for prefix in args.prefix:
        try:
            successful = collect(prefix, token, account, deadline) and successful
        except (KeyError, TypeError, ValueError, OSError) as error:
            print(json.dumps({"prefix": str(prefix), "status": "error", "error": str(error).replace(token, "[redacted]")}), file=sys.stderr)
            successful = False
    return 0 if successful else 1


if __name__ == "__main__":
    sys.exit(main())

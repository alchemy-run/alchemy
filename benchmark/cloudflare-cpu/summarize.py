"""Summarize captured invocation CPU independently from client latency.

Usage: python3 benchmark/cloudflare-cpu/summarize.py PREFIX [PREFIX ...]
Invalid or incomplete cohorts keep coverage diagnostics but have no CPU summary.
"""
import importlib.util
import json
import math
import statistics
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cpu_collection", Path(__file__).with_name("collect-cpu.py"))
cpu_collection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu_collection)


def stats(values):
    values = sorted(values)
    if not values:
        return None
    return {
        "n": len(values),
        "mean": statistics.mean(values),
        "p50": statistics.median(values),
        "p95": values[math.ceil(len(values) * .95) - 1],
        "min": values[0],
        "max": values[-1],
    }


def summarize(prefix):
    prefix = str(prefix)
    client = json.loads(Path(prefix + "-latency.json").read_text())
    groups = {}
    cpu_path = Path(prefix + "-cpu.json")
    cpu = json.loads(cpu_path.read_text())
    expected_version = cpu_collection.manifest_version(client)
    expected = cpu_collection.expected_counts(client)
    # Revalidate raw samples, including historical schemaVersion 1 files whose
    # collector could declare a mixed-version cohort complete.
    coverage = cpu_collection.coverage(
        {str(index): event for index, event in enumerate(cpu["samples"])},
        expected, client["totalRequests"], expected_version,
    )
    identity_matches = cpu.get("runId") == client["runId"]
    membership_matches = True
    events = cpu["samples"]
    for event in events:
        url = urlparse(event["url"])
        query = parse_qs(url.query)
        membership_matches &= (
            cpu_collection.origin(event["url"]) == cpu_collection.origin(client["url"])
            and query.get("run") == [client["runId"]]
            and (url.path, (query.get("phase") or [None])[0]) in expected
        )
        if query.get("phase") != ["measured"]:
            continue
        group = groups.setdefault(url.path[1:], {"cpu": [], "wall": [], "outcomes": {}})
        for field, output in (("cpuTimeMs", "cpu"), ("wallTimeMs", "wall")):
            value = cpu_collection.number(event.get(field))
            if value is not None:
                group[output].append(value)
        outcome = event.get("outcome", "missing")
        group["outcomes"][outcome] = group["outcomes"].get(outcome, 0) + 1
    valid = (cpu.get("status") == "complete" and coverage["complete"]
             and client.get("allCorrect") is True and identity_matches and membership_matches)
    return {
        "prefix": prefix,
        "variant": client["variant"],
        "version": client["versionBefore"],
        "versionStable": client["versionStable"],
        "allCorrect": client["allCorrect"],
        "valid": valid,
        "status": "complete" if valid else "invalid-or-incomplete",
        "configuration": client["configuration"],
        "startedAt": client["startedAt"],
        "endedAt": client["endedAt"],
        "cpuSource": "stored invocation telemetry",
        "coverage": coverage,
        "identityMatches": identity_matches,
        "membershipMatches": membership_matches,
        "workloads": {
            name: {"cpuMs": stats(group["cpu"]), "wallMs": stats(group["wall"]), "outcomes": group["outcomes"]}
            for name, group in groups.items()
        } if valid else {},
        "clientWorkloads": {workload["endpoint"]: workload["summary"] for workload in client["workloads"]},
        "notes": "CPU requires complete, correct, same-version coverage. Invalid cohorts keep diagnostics without CPU statistics; client latency is never CPU.",
    }


if __name__ == "__main__":
    results = [summarize(prefix) for prefix in sys.argv[1:]]
    print(json.dumps(results, indent=2, allow_nan=False))
    sys.exit(0 if results and all(result["valid"] for result in results) else 1)

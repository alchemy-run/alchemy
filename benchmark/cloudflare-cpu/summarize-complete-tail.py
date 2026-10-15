"""Use live CPU only when every measured client request has one exact CF-Ray match.

Raw headers stay local. This never fills missing values from latency or joins
unrelated events by approximate timestamps. Stored telemetry stays untouched.
"""
import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlparse
from summarize import stats

prefix = sys.argv[1]
client = json.loads(Path(prefix + "-latency.json").read_text())
observer = json.loads(Path(prefix + "-observer.json").read_text())
assert client["allCorrect"] and client["versionStable"]
version = client["versionBefore"]["id"]
ray = lambda value: value.split("-")[0].lower()
expected = {}
for workload in client["workloads"]:
    for sample in workload["measured"]["samples"]:
        key = ray(sample["cfRay"])
        assert key not in expected
        expected[key] = workload["endpoint"]

samples = []
seen = set()
for line in Path(prefix + "-tail.jsonl").read_text().splitlines():
    event = json.loads(line)
    request = event.get("event", {}).get("request", {})
    url = urlparse(request.get("url", ""))
    query = parse_qs(url.query)
    if query.get("phase") != ["measured"]:
        continue
    assert query.get("run") == [client["runId"]]
    assert (url.scheme, url.netloc) == (urlparse(client["url"]).scheme, urlparse(client["url"]).netloc)
    assert event["scriptName"] == observer["worker"]
    assert event["scriptVersion"]["id"] == version
    assert event["outcome"] == "ok" and not event["truncated"]
    key = ray(request["headers"]["cf-ray"])
    assert key in expected and key not in seen
    assert url.path == "/" + expected[key]
    assert isinstance(event["cpuTime"], (float, int)) and event["cpuTime"] >= 0
    assert isinstance(event["wallTime"], (float, int)) and event["wallTime"] >= 0
    seen.add(key)
    samples.append({
        "cfRay": key, "endpoint": expected[key], "cpuTimeMs": event["cpuTime"],
        "wallTimeMs": event["wallTime"], "eventTimestamp": event["eventTimestamp"],
    })
assert seen == set(expected), "Live tail is incomplete; do not summarize it as a complete cohort"

result = {
    "schemaVersion": 1, "prefix": prefix, "version": version,
    "variant": client["variant"], "configuration": client["configuration"],
    "allCorrect": True, "source": "Live invocation CPU, one exact CF-Ray match per measured client request",
    "coverage": {"expected": len(expected), "observed": len(seen), "complete": True},
    "workloads": {name: {
        "cpuMs": stats([s["cpuTimeMs"] for s in samples if s["endpoint"] == name]),
        "wallMs": stats([s["wallTimeMs"] for s in samples if s["endpoint"] == name]),
    } for name in sorted(set(expected.values()))},
    "samples": samples,
    "notes": "Provider CPU only; no imputation. Raw headers/IPs excluded. Stored telemetry remains separately available.",
}
print(json.dumps(result, indent=2))

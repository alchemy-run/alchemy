import glob
import os
import subprocess


def handler(event, context):
    # Lambda installs the NVIDIA driver on the instance and exposes the
    # execution environment's GPU (or GPU fraction) to the container.
    gpus = sorted(glob.glob("/proc/driver/nvidia/gpus/*"))
    try:
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        smi = None
    return {
        "marker": os.environ.get("GPU_MARKER"),
        "gpuCount": len(gpus),
        "nvidiaSmi": smi,
    }

import json

from .runtime import run_from_environment


def main() -> None:
    print(json.dumps(run_from_environment()), flush=True)

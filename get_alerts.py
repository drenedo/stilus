
import argparse
import json
from deepdiff import DeepDiff
from pathlib import Path

import requests

from get_token import CONFIG_PATH, get_token, load_config

OUTPUT_PATH = Path(__file__).parent / "children.json"
COMMUNICATIONS_URL = "https://stilus.educa.jcyl.es/bkstfm/comunicaciones/{child}"
DEFAULT_PARAMS = {
    "clase": "recibidas",
    "archivada": "false",
    "offset": 1,
    "limit": 80,
    "sort": "-fechaComunicacion",
}


def get_children(config: dict) -> list:
    children = config.get("children") or []
    if not children:
        raise SystemExit("Missing children: set a non-empty children list in the YAML file.")
    return children


def fetch_communications(child, token: str, params: dict | None = None) -> dict:
    response = requests.get(
        COMMUNICATIONS_URL.format(child=child),
        params={**DEFAULT_PARAMS, **(params or {})},
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def children_notifications(children, token):
    for child in children:
        print(f"Fetching communications for child {child}...")
        try:
            result = fetch_communications(child, token)
            previous = read_file(child)
            with open(f"{child}.json", "w+") as file:
                diff = DeepDiff(previous, result['datos'], ignore_order=True)
                print("Diff:")
                print(f"{diff}")
                json.dump(result['datos'], file, indent=2, ensure_ascii=False)
                file.write("\n")
        except requests.HTTPError as error:
            print(f"Request failed: {error}")


def read_file(child):
    path = Path(f"{child}.json")
    if not path.exists():
        print(f"File {path} does not exist yet.")
        return []
    content = path.read_text(encoding="utf-8").strip()
    if not content:
        print(f"File {path} is empty.")
        return []
    print(f"Reading file {path}...")
    return json.loads(content)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Stilus alerts.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help="Path to the YAML configuration file.",
    )
    args = parser.parse_args()
    config = load_config(args.config)
    children = get_children(config)
    print("Getting token...")
    token = get_token(config=config)
    children_notifications(children, token)


if __name__ == "__main__":
    main()

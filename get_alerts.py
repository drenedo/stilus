"""Fetch Stilus alerts."""

import argparse
from pathlib import Path

from get_token import CONFIG_PATH, get_token


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Stilus alerts.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help="Path to the YAML configuration file.",
    )
    args = parser.parse_args()

    print("Getting token...")
    token = get_token(config_path=args.config)
    print(f"token: {token}")


if __name__ == "__main__":
    main()

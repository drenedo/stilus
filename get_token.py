
import argparse
import json
import sys
from pathlib import Path

import yaml
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

CONFIG_PATH = Path(__file__).parent / "config.yaml"
DEFAULT_URL = "https://stilus.educa.jcyl.es/ftstfm/"


class AuthenticationError(Exception):
    """Raised when the portal rejects the supplied credentials."""


def load_config(path: Path = CONFIG_PATH) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def get_stdin_credentials() -> tuple[str, str]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Invalid credentials JSON on stdin: {error}") from error
    if not isinstance(payload, dict):
        raise SystemExit("Invalid credentials JSON on stdin: expected an object.")
    name = str(payload.get("name") or "").strip()
    password = payload.get("password") or ""
    if not name or not password:
        raise SystemExit("Missing credentials: provide name and password on stdin.")
    return name, password


def get_credentials(config: dict) -> tuple[str, str]:
    user = config.get("user") or {}
    name = user.get("name")
    password = user.get("password")
    if not name or not password:
        raise SystemExit("Missing credentials: set user.name and user.password in the YAML file.")
    return name, password


def get_geckodriver_path(config: dict) -> Path | None:
    path = config.get("geckodriver")
    if not path:
        return None
    path = Path(path)
    if not path.exists():
        raise SystemExit(f"Geckodriver not found at {path}.")
    return path


def create_driver(config: dict) -> webdriver.Firefox:
    options = Options()
    options.add_argument("-headless")
    geckodriver = get_geckodriver_path(config)
    if geckodriver:
        service = webdriver.FirefoxService(executable_path=str(geckodriver))
        driver = webdriver.Firefox(options=options, service=service)
    else:
        # No explicit path: Selenium Manager locates or downloads geckodriver.
        driver = webdriver.Firefox(options=options)
    driver.implicitly_wait(10)
    return driver


def login(driver: webdriver.Firefox, name: str, password: str) -> None:
    wait = WebDriverWait(driver, 20)
    wait.until(EC.visibility_of_element_located((By.ID, "userNameInput"))).send_keys(name)
    driver.find_element(By.ID, "passwordInput").send_keys(password)
    driver.find_element(By.ID, "submitButton").click()
    print("checking url...")

    def login_result(driver: webdriver.Firefox) -> str | bool:
        if driver.current_url.startswith("https://stilus.educa.jcyl.es"):
            return "success"
        errors = driver.find_elements(By.ID, "errorText")
        if errors and errors[0].is_displayed() and errors[0].text.strip():
            return "error"
        return False

    result = wait.until(login_result)
    if result == "error":
        errors = driver.find_elements(By.ID, "errorText")
        message = errors[0].text.strip() if errors else ""
        raise AuthenticationError(message or "Authentication rejected by the portal.")
    print("checked!")


def extract_token(url: str) -> str:
    token = url.split("#access_token=")[1].split("&")[0]
    print(f"Token: {token}")
    if not token:
        raise SystemExit(f"No access_token found in the redirect URL: {url}")
    return token


def get_token(config: dict | None = None, config_path: Path = CONFIG_PATH) -> str:
    config = config or load_config(config_path)
    name, password = get_credentials(config)
    driver = create_driver(config)
    try:
        driver.get(config.get("url") or DEFAULT_URL)
        login(driver, name, password)
        return extract_token(driver.current_url)
    finally:
        driver.close()
        driver.quit()


def main() -> None:
    parser = argparse.ArgumentParser(description="Print a Stilus access token.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help="Path to the YAML configuration file.",
    )
    parser.add_argument(
        "--credentials-stdin",
        action="store_true",
        help="Read user credentials as JSON from stdin instead of config.yaml.",
    )
    args = parser.parse_args()

    if args.credentials_stdin:
        name, password = get_stdin_credentials()
        config = load_config(args.config)
        config["user"] = {"name": name, "password": password}
        print(get_token(config=config))
    else:
        print(get_token(config_path=args.config))


if __name__ == "__main__":
    main()

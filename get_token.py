"""Obtain an access token from the Stilus portal via Selenium."""

import argparse
from pathlib import Path
from urllib.parse import parse_qs

import yaml
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

CONFIG_PATH = Path(__file__).parent / "config.yaml"
GECKODRIVER_PATH = Path("/snap/bin/firefox.geckodriver")


def load_config(path: Path = CONFIG_PATH) -> dict:
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def get_credentials(config: dict) -> tuple[str, str]:
    user = config.get("user") or {}
    name = user.get("name")
    password = user.get("password")
    if not name or not password:
        raise SystemExit("Missing credentials: set user.name and user.password in the YAML file.")
    return name, password


def create_driver() -> webdriver.Firefox:
    options = Options()
    #options.add_argument("-headless")
    service = (
        webdriver.FirefoxService(executable_path=str(GECKODRIVER_PATH))
        if GECKODRIVER_PATH.exists()
        else None
    )
    driver = webdriver.Firefox(options=options, service=service)
    driver.implicitly_wait(10)
    return driver


def login(driver: webdriver.Firefox, name: str, password: str) -> None:
    wait = WebDriverWait(driver, 20)
    wait.until(EC.visibility_of_element_located((By.ID, "userNameInput"))).send_keys(name)
    driver.find_element(By.ID, "passwordInput").send_keys(password)
    driver.find_element(By.ID, "submitButton").click()
    wait.until(
        lambda driver: driver.current_url.startswith("https://stilus.educa.jcyl.es"))
    errors = [el.text.strip() for el in driver.find_elements(By.ID, "errorText") if el.text.strip()]
    if errors:
        raise SystemExit(f"Sign-in error: {errors[0]}")


def extract_token(url: str) -> str:
    fragment = url.partition("#")[2]
    token = parse_qs(fragment).get("access_token", [None])[0]
    if not token:
        raise SystemExit(f"No access_token found in the redirect URL: {url}")
    return token


def get_token(config: dict | None = None, config_path: Path = CONFIG_PATH) -> str:
    config = config or load_config(config_path)
    name, password = get_credentials(config)
    driver = create_driver()
    try:
        driver.get(config["url"])
        login(driver, name, password)
        return extract_token(driver.current_url)
    finally:
        driver.quit()


def main() -> None:
    parser = argparse.ArgumentParser(description="Print a Stilus access token.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help="Path to the YAML configuration file.",
    )
    args = parser.parse_args()
    print(get_token(config_path=args.config))


if __name__ == "__main__":
    main()

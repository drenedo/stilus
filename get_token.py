
import argparse
import json
import os
import sys
import time
from pathlib import Path

import yaml
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

CONFIG_PATH = Path(__file__).parent / "config.yaml"
DEFAULT_URL = "https://stilus.educa.jcyl.es/ftstfm/"
DEFAULT_LOGIN_TIMEOUT = 45.0
DEFAULT_LOGIN_ATTEMPTS = 2
DEFAULT_LOGIN_BUDGET = 110.0


class AuthenticationError(Exception):
    """Raised when the portal rejects the supplied credentials."""


def get_positive_number(config: dict, key: str, default: float) -> float:
    value = config.get(key, default)
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"Invalid {key!r} value: {value!r}.") from error
    if number <= 0:
        raise SystemExit(f"Invalid {key!r} value: must be greater than zero.")
    return number


def get_login_timeout(config: dict) -> float:
    return get_positive_number(config, "login_timeout", DEFAULT_LOGIN_TIMEOUT)


def get_login_attempts(config: dict) -> int:
    attempts = get_positive_number(config, "login_attempts", DEFAULT_LOGIN_ATTEMPTS)
    return max(1, int(attempts))


def describe_page(driver: webdriver.Firefox) -> tuple[str, str]:
    try:
        url = driver.current_url
    except WebDriverException:
        url = "<unavailable>"
    try:
        title = driver.title
    except WebDriverException:
        title = "<unavailable>"
    return url, title


def log_login_failure(
    driver: webdriver.Firefox, description: str, attempt: int, attempts: int
) -> None:
    url, title = describe_page(driver)
    print(
        f"Login attempt {attempt}/{attempts} failed: {description} "
        f"(url={url!r}, title={title!r}).",
        file=sys.stderr,
    )

    debug_dir = Path(os.environ.get("STILUS_DEBUG_DIR") or "/tmp")
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        screenshot = debug_dir / f"stilus-login-{int(time.time())}.png"
        driver.save_screenshot(str(screenshot))
        print(f"Login screenshot: {screenshot}", file=sys.stderr)
    except Exception as error:  # Diagnostics must never mask the login error.
        print(f"Could not save login screenshot: {error}", file=sys.stderr)


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


def create_driver(
    config: dict, page_load_timeout: float | None = None
) -> webdriver.Firefox:
    options = Options()
    options.add_argument("-headless")
    geckodriver = get_geckodriver_path(config)
    if geckodriver:
        service = webdriver.FirefoxService(executable_path=str(geckodriver))
        driver = webdriver.Firefox(options=options, service=service)
    else:
        # No explicit path: Selenium Manager locates or downloads geckodriver.
        driver = webdriver.Firefox(options=options)
    # Do not mix implicit waits with the explicit waits used by login(): the
    # implicit wait makes every poll block and hides the real timeout.
    driver.implicitly_wait(0)
    driver.set_page_load_timeout(
        page_load_timeout
        if page_load_timeout is not None
        else get_login_timeout(config)
    )
    return driver


def login(
    driver: webdriver.Firefox,
    name: str,
    password: str,
    timeout: float = DEFAULT_LOGIN_TIMEOUT,
    attempt: int = 1,
    attempts: int = 1,
) -> None:
    wait = WebDriverWait(driver, timeout)
    try:
        wait.until(
            EC.visibility_of_element_located((By.ID, "userNameInput"))
        ).send_keys(name)
        wait.until(
            EC.visibility_of_element_located((By.ID, "passwordInput"))
        ).send_keys(password)
        wait.until(EC.element_to_be_clickable((By.ID, "submitButton"))).click()
    except TimeoutException:
        # The browser may still be on the Stilus SPA because the redirect to
        # ADFS did not happen in time. Record what was actually rendered.
        log_login_failure(
            driver,
            "the ADFS login form did not become ready",
            attempt,
            attempts,
        )
        raise
    print("checking url...")

    def login_result(driver: webdriver.Firefox) -> str | bool:
        if driver.current_url.startswith("https://stilus.educa.jcyl.es"):
            return "success"
        errors = driver.find_elements(By.ID, "errorText")
        if errors and errors[0].is_displayed() and errors[0].text.strip():
            return "error"
        return False

    try:
        result = wait.until(login_result)
    except TimeoutException:
        log_login_failure(
            driver,
            "the portal did not redirect after submitting the credentials",
            attempt,
            attempts,
        )
        raise
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
    url = config.get("url") or DEFAULT_URL
    timeout = get_login_timeout(config)
    attempts = get_login_attempts(config)
    budget = get_positive_number(config, "login_budget", DEFAULT_LOGIN_BUDGET)
    deadline = time.monotonic() + budget

    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            break

        driver = create_driver(config, page_load_timeout=min(timeout, remaining))
        try:
            driver.get(url)
            login(
                driver,
                name,
                password,
                timeout=min(timeout, max(1.0, deadline - time.monotonic())),
                attempt=attempt,
                attempts=attempts,
            )
            return extract_token(driver.current_url)
        except AuthenticationError:
            # Bad credentials are not transient: do not retry them.
            raise
        except (TimeoutException, WebDriverException) as error:
            last_error = error
            if attempt < attempts and deadline - time.monotonic() > 1:
                print(
                    f"Retrying login ({attempt + 1}/{attempts}) after a "
                    "transient browser/portal error.",
                    file=sys.stderr,
                )
                time.sleep(min(2 * attempt, 5))
        finally:
            driver.quit()

    if last_error is not None:
        raise last_error
    raise TimeoutException(
        f"Login did not finish within the {budget:g}s budget."
    )


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

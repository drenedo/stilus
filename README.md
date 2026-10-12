# Stilus

Fetch communications from the
[Stilus](https://stilus.educa.jcyl.es/) portal.

## Requirements

- Python 3.10 or newer (the code uses `X | Y` type unions)
- Firefox and `geckodriver` — the driver location is set in `config.yaml`

## Install

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## Configuration

Create a `config.yaml` file next to the scripts:

```yaml
url: https://stilus.educa.jcyl.es/ftstfm/
geckodriver: /snap/bin/firefox.geckodriver

user:
  name: "nombre.apellido@educa.jcyl.es"
  password: "your-password"

children:
  - 10000001
  - 10000002
```

| Key | Description |
| --- | --- |
| `url` | Portal entry point. Visiting it triggers the sign-in redirect that carries the access token. |
| `geckodriver` | Absolute path to the `geckodriver` binary. Required; there is no fallback to `PATH`. |
| `user.name` | Your `@educa.jcyl.es` account. |
| `user.password` | Password for that account. |
| `children` | Student ids whose communications are fetched. One request is made per id. |

The `children` ids are the portal's internal student identifiers, not the
student's name or document number. You can read them off the portal URL when
you select a child in the web interface.

`config.yaml` holds a plaintext password and is listed in `.gitignore`. Keep it
that way — do not commit it.

## Usage

```bash
./venv/bin/python get_alerts.py
```

What happens:

1. Firefox opens and signs in with the configured credentials. It is **not**
   headless, so a window appears; the `-headless` argument is commented out in
   `get_token.py` if you want to change that.
2. The access token is extracted from the redirect URL fragment.
3. For each child, the communications endpoint is queried.
4. The new response is compared against the previous one with `DeepDiff` and
   the difference is printed.
5. The response is written to `<child-id>.json`, overwriting the previous file,
   which becomes the baseline for the next run.

On the first run there is no baseline file, so every communication is reported
as added. That is expected.

Fetch a token on its own, without touching the communications endpoint:

```bash
./venv/bin/python get_token.py
```

Both scripts accept `--config` to point at a configuration file elsewhere:

```bash
./venv/bin/python get_alerts.py --config /path/to/other.yaml
```

## Output

One file per child, named after the id, holding the `datos` array of the
response:

```
10000001.json
10000002.json
```

These contain the children's school correspondence and are covered by the
`*.json` entry in `.gitignore`.

## Notes

- The query sent to the endpoint is fixed in `DEFAULT_PARAMS` in
  `get_alerts.py`: received messages, not archived, the 80 most recent, newest
  first. Edit that dictionary to change it.
- Each run signs in from scratch. Tokens are not cached between runs.

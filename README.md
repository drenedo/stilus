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


Both scripts accept `--config` to point at a configuration file elsewhere:

```bash
./venv/bin/python get_alerts.py --config /path/to/other.yaml
```

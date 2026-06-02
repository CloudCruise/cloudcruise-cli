# Changelog

## 1.7.0

### Added

- `vault create` and `vault update` accept `--proxy <setting>` (`random`/`static`/`country`/`custom`) and `--proxy-value <value>`. For the Enterprise `custom` (bring-your-own) proxy, the URL is encrypted client-side with the workspace key before sending; for `static`/`country` the value (target IP / country code) is sent as plaintext.
- `--proxy-value-stdin` reads a custom proxy URL from stdin, keeping credentials out of shell history and process listings.

### Security

- `--proxy` is validated against the allowed enum before any request is sent.
- A custom `--proxy-value` is refused as a command-line argument (it may contain embedded credentials) and must be supplied via `--proxy-value-stdin`, matching the existing handling for `--password`/`--tfa-secret`.
- Setting `proxy_value` without `proxy_setting` is rejected, preventing a custom proxy URL from being sent in plaintext.

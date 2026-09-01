# CloudCruise plugin setup

The skills in this plugin drive the `cloudcruise` CLI. Before using them, make sure the CLI is installed and authenticated.

## 1. Check for the CLI

```bash
command -v cloudcruise
```

If it prints a path, skip to step 3.

## 2. Install the CLI

```bash
npm install -g @cloudcruise/cli
```

Requires Node.js 18+. If `npm` is missing, ask the user how they'd like to install Node first.

## 3. Authenticate

```bash
cloudcruise login
```

This opens a browser for sign-in. It's interactive — the user must complete it themselves. If running in a headless environment, the user can instead set an API key profile; see the `cloudcruise` skill for details.

## 4. Verify

```bash
cloudcruise workflows list
```

A workflow listing (even an empty one) means setup is complete. An auth error means step 3 didn't finish.

# pi-codex-image-tool

Minimal Pi extension scaffold with a `greetings` test tool registered through Pi's `registerTool` API.

> GitHub link: 

## Pi Package Info

This repository is a Pi package. Its `package.json` contains:

- `keywords: ["pi-package", ...]` for Pi package discoverability
- `peerDependencies` for Pi-provided runtime packages
- a `pi.extensions` manifest pointing to `extensions/index.ts`

```json
{
  "pi": {
    "extensions": ["extensions/index.ts"]
  }
}
```

## Extension

### `greetings` tool

The extension exposes the `greetings` tool only when Pi's current model matches `gpt-5.x` with `x >= 5` (for example `gpt-5.5` or `gpt-5.10`). It syncs this on session start and whenever the user switches models. For any other model, the tool is removed from the active tool list so it does not appear in the LLM prompt.

When active and the user says `greetings`, the LLM can call the `greetings` tool. The tool prints and returns:

```text
Hello, my name is Pi!
```

The tool has no parameters.

## Install / Use Locally

From this repository:

```bash
bun install
pi -e .
```

Or install it as a local Pi package:

```bash
pi install /Users/rossz/workspace/ai-tools/pi/rossz-extensions/pi-codex-image-tool
```

For project-local installation in another repo, run:

```bash
pi install -l /Users/rossz/workspace/ai-tools/pi/rossz-extensions/pi-codex-image-tool
```

## Verify

Start Pi with the extension loaded, switch to a matching model such as `gpt-5.5`, then prompt:

```text
greetings
```

The agent should call the `greetings` tool and show:

```text
Hello, my name is Pi!
```

## Development

This scaffold was initialized with Bun:

```bash
bun init -y
```

Useful commands:

```bash
bun install
bun run check
```

## Requirements

- Pi installed and configured
- Bun for local development

## Security

Pi extensions run with your full system permissions. Review extension source before installing or sharing.

## License

MIT

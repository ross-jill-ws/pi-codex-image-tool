# pi-codex-image-tool

Pi extension for the `openai-codex` provider. It exposes a `codex_image` wrapper tool that lets Pi ask Codex to use its native hosted image-generation capability and save the streamed image bytes to disk, and it adds an OpenAI `service_tier` selector (footer display + `alt+shift+tab` cycling) applied to every Codex request.

> GitHub link: https://github.com/ross-jill-ws/pi-codex-image-tool

## Why this exists

GPT-5.5+ can generate images through its own API-side hosted tool. This is **not** a normal Pi function tool named `generate_image`; the request must include OpenAI/Codex's native tool shape:

```json
{
  "tools": [
    {
      "type": "image_generation",
      "model": "gpt-image-2",
      "size": "1024x1024"
    }
  ],
  "tool_choice": { "type": "image_generation" }
}
```

This extension registers a Pi wrapper tool named `codex_image`. When GPT-5.5 calls that wrapper, the wrapper sends a separate request to the current GPT-5.5/Codex model using only the native `image_generation` hosted tool above, parses the streamed response, and writes the image to disk.

## Authentication: no `OPENAI_API_KEY` required

You do **not** need to set `OPENAI_API_KEY` for this extension if you already use Pi with a Codex/ChatGPT subscription.

As long as your current Pi model belongs to the `openai-codex` provider, the extension uses Pi's existing model auth/session. In other words, your existing Codex subscription is enough.

## Usage

Switch Pi to a matching model such as `gpt-5.5`, then ask naturally:

```text
Generate an image of an orange cat sitting by a window
```

If you have other image tools installed, such as Nano Banana, be explicit:

```text
Generate an image of an orange cat sitting by a window using codex_image tool
```

You can also specify a save location:

```text
Generate an image of a panda using codex_image tool and save it to ./panda-images
```

### Image size

Mention the image size in the prompt with `widthxheight`, for example:

```text
Generate an image of a futuristic city using codex_image tool at 1024x1536
```

Size notes:

- One dimension must be larger than `1024`.
- Both width and height must be multiples of `16`.
- Examples: `1024x1536`, `1536x1024`, `1088x1440`.

## Examples

Tool result in Pi:

![codex_image tool result in Pi](media/codex-image-tool-result.png)

Generated image:

![Generated orange cat](media/codex-image-cat.png)

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

## Extension behavior

### Provider gating

Everything in this extension (the `codex_image` tool, the service-tier request property, the footer display, and the keyboard shortcut) is active only while Pi's current model belongs to the `openai-codex` provider. The extension syncs this on session start and whenever the user switches models.

### `codex_image` tool

The extension exposes the `codex_image` Pi wrapper tool only when the current model's provider is `openai-codex`. For any other provider, the wrapper is removed from the active tool list so it does not appear in the LLM prompt.

The OpenAI/Codex API request does **not** define a `generate_image` function tool. It only sends the native hosted image tool as `type: "image_generation"`.

Tool parameters:

| Parameter | Type | Required | Description |
|---|---:|---:|---|
| `prompt` | string | yes | Detailed prompt describing the image to generate |
| `size` | enum | yes | Image size requested from `gpt-image-2` |
| `target-path` | string | yes | Directory where streamed image data is saved. Defaults to `/tmp/pi-codex-image-tool` |

Fixed API tool settings:

- `type`: `image_generation`
- `model`: `gpt-image-2`

The extension parses streamed SSE `data:` events, including `partial_image_b64` / `result` image payloads, and saves the first image payload to `target-path` as soon as it arrives. The generated image is also returned inline to Pi.

### Service tier

While an `openai-codex` model is active, the extension injects a top-level `service_tier` property into every request body Pi sends to the provider (and into its own `codex_image` requests):

```json
{
  "model": "gpt-5.6-luna",
  "store": false,
  "stream": true,
  "service_tier": "priority",
  "reasoning": { "effort": "high", "summary": "auto" }
}
```

- Available values: `default` | `priority` (default: `default`).
- The active tier is displayed at the bottom-right of the footer, e.g. `tier: priority`.
- Press `alt+shift+tab` (option+shift+tab on macOS) to cycle through the values. The selection is persisted in the session, so it survives resume.
- Start Pi with `pi --codex-service-tier priority` to set the tier directly. The CLI flag overrides the session-persisted value.

## Install / Use Locally

From this repository:

```bash
bun install
pi -e .
```

Or install it globally from npm:

```bash
pi install npm:pi-codex-image-tool
```

For project-local installation in another repo, run:

```bash
pi install -l npm:pi-codex-image-tool
```

## Verify

Start Pi with the extension loaded, switch to a matching model such as `gpt-5.5`, then prompt:

```text
Generate an image of a tiny robot painting a sunset using codex_image tool at 1024x1536 and save it under /tmp/pi-images
```

The agent should call `codex_image`, then return the generated image and saved file path.

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
- Current Pi model from the `openai-codex` provider
- Existing Codex/ChatGPT subscription auth in Pi
- Bun for local development

## Security

Pi extensions run with your full system permissions. Review extension source before installing or sharing.

## License

MIT

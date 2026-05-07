# pi-codex-image-tool

Pi extension that exposes a `codex_image` wrapper tool for `gpt-5.5+` models. The wrapper lets Pi ask Codex/GPT-5.5 to use its native hosted image-generation capability and save the streamed image bytes to disk.

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

As long as your current Pi model is `gpt-5.5` or another matching `gpt-5.x` model where `x >= 5`, the extension uses Pi's existing model auth/session. In other words, your existing Codex subscription is enough.

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

### `codex_image` tool

The extension exposes the `codex_image` Pi wrapper tool only when Pi's current model matches `gpt-5.x` with `x >= 5` (for example `gpt-5.5` or `gpt-5.10`). It syncs this on session start and whenever the user switches models. For any other model, the wrapper is removed from the active tool list so it does not appear in the LLM prompt.

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
- Current Pi model set to `gpt-5.5+`
- Existing Codex/ChatGPT subscription auth in Pi
- Bun for local development

## Security

Pi extensions run with your full system permissions. Review extension source before installing or sharing.

## License

MIT

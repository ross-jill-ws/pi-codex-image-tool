/**
 * pi-codex-image-tool
 *
 * Dynamically exposes a `codex_image` Pi wrapper tool only while Pi is using a
 * `gpt-5.x` model where x >= 5 (for example gpt-5.5 or gpt-5.10). The tool
 * calls the current model's Responses endpoint with OpenAI's image-generation
 * tool configuration:
 *
 *   tools: [{ type: "image_generation", model: "gpt-image-2", size }]
 *   tool_choice: { type: "image_generation" }
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum, Type, type Model, type Static } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TOOL_NAME = "codex_image";
const MIN_TARGET_MODEL_MINOR = 5;
const IMAGE_GENERATION_TOOL_TYPE = "image_generation";
const IMAGE_MODEL = "gpt-image-2";
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const DEFAULT_TARGET_PATH = "/tmp/pi-codex-image-tool";

const GenerateImageParams = Type.Object({
  prompt: Type.String({
    description: "Detailed prompt describing the image to generate.",
  }),
  size: StringEnum(IMAGE_SIZES, {
    description: "Output image size.",
    default: "1024x1024",
  }),
  "target-path": Type.String({
    description:
      "Directory where the generated image should be saved. Relative paths are resolved from the current working directory.",
    default: DEFAULT_TARGET_PATH,
  }),
});

type GenerateImageParamsType = Static<typeof GenerateImageParams>;

interface GenerateImageDetails {
  model: string;
  imageModel: typeof IMAGE_MODEL;
  size: GenerateImageParamsType["size"];
  targetPath: string;
  outputPath: string;
  mimeType: string;
  responseId?: string;
}

interface SavedImage {
  outputPath: string;
  mimeType: string;
  base64: string;
}

function isGpt5AtLeast55(value: string): boolean {
  const match = value.toLowerCase().match(/(?:^|[^a-z0-9])gpt-5\.(\d+)(?:$|[^\d])/);
  if (!match) return false;

  const minorText = match[1];
  if (!minorText) return false;

  const minor = Number.parseInt(minorText, 10);
  return Number.isFinite(minor) && minor >= MIN_TARGET_MODEL_MINOR;
}

function isTargetModel(model: Model<any> | undefined): model is Model<any> {
  if (!model) return false;

  return [model.id, model.name].some(isGpt5AtLeast55);
}

function resolveResponsesUrl(model: Model<any>): string {
  const baseUrl = model.baseUrl.replace(/\/+$/, "");

  if (model.api === "openai-codex-responses") {
    if (baseUrl.endsWith("/codex/responses")) return baseUrl;
    if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
    return `${baseUrl}/codex/responses`;
  }

  if (baseUrl.endsWith("/responses")) return baseUrl;
  return `${baseUrl}/responses`;
}

function hasHeader(headers: Headers, name: string): boolean {
  for (const key of headers.keys()) {
    if (key.toLowerCase() === name.toLowerCase()) return true;
  }
  return false;
}

function extractChatGptAccountId(token: string): string | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;

    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded?.https?.["api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

async function buildHeaders(ctx: ExtensionContext, model: Model<any>): Promise<Headers> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const headers = new Headers(auth.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream, application/json");

  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.set("authorization", `Bearer ${auth.apiKey}`);
  }

  if (model.api === "openai-codex-responses") {
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", "pi");

    if (auth.apiKey && !hasHeader(headers, "chatgpt-account-id")) {
      const accountId = extractChatGptAccountId(auth.apiKey);
      if (accountId) headers.set("chatgpt-account-id", accountId);
    }
  }

  return headers;
}

function buildRequestBody(model: Model<any>, params: GenerateImageParamsType) {
  return {
    model: model.id,
    store: false,
    stream: true,
    instructions: "You are a helpful assistant.",
    reasoning: {
      effort: "high",
      summary: "auto",
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: params.prompt,
          },
        ],
      },
    ],
    text: {
      verbosity: "medium",
    },
    tools: [
      {
        type: IMAGE_GENERATION_TOOL_TYPE,
        model: IMAGE_MODEL,
        size: params.size,
      },
    ],
    tool_choice: { type: IMAGE_GENERATION_TOOL_TYPE },
    parallel_tool_calls: true,
  };
}

function stripDataUrl(value: string): string {
  const match = value.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  return match?.[1] ?? value;
}

function isProbablyBase64Image(value: string): boolean {
  const stripped = stripDataUrl(value);
  return stripped.length > 100 && /^[A-Za-z0-9+/=_-]+$/.test(stripped);
}

function collectImageBase64(payload: unknown, images: string[] = []): string[] {
  if (!payload || typeof payload !== "object") return images;

  if (Array.isArray(payload)) {
    for (const item of payload) collectImageBase64(item, images);
    return images;
  }

  const record = payload as Record<string, unknown>;

  if (record.type === "image_generation_call" && typeof record.result === "string") {
    images.push(stripDataUrl(record.result));
  }

  for (const key of ["partial_image_b64", "b64_json", "image_base64", "base64", "data", "result"] as const) {
    const value = record[key];
    if (typeof value === "string" && isProbablyBase64Image(value)) {
      images.push(stripDataUrl(value));
    }
  }

  for (const value of Object.values(record)) {
    collectImageBase64(value, images);
  }

  return [...new Set(images)];
}

function extractResponseId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const id = extractResponseId(item);
      if (id) return id;
    }
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.startsWith("resp_")) return record.id;

  const response = record.response;
  if (response && typeof response === "object" && typeof (response as Record<string, unknown>).id === "string") {
    return (response as Record<string, string>).id;
  }

  return undefined;
}

function detectImageMimeType(base64: string): { mimeType: string; extension: string } {
  if (base64.startsWith("/9j/")) return { mimeType: "image/jpeg", extension: "jpg" };
  if (base64.startsWith("UklGR")) return { mimeType: "image/webp", extension: "webp" };
  return { mimeType: "image/png", extension: "png" };
}

function resolveTargetPath(ctx: ExtensionContext, params: GenerateImageParamsType): string {
  const targetPath = params["target-path"] || DEFAULT_TARGET_PATH;
  return isAbsolute(targetPath) ? targetPath : resolve(ctx.cwd, targetPath);
}

async function saveImageToTarget(
  ctx: ExtensionContext,
  base64: string,
  params: GenerateImageParamsType,
): Promise<SavedImage> {
  const { mimeType, extension } = detectImageMimeType(base64);
  const targetPath = resolveTargetPath(ctx, params);
  const fileName = `image_${Date.now()}_${params.size.replace("x", "-")}.${extension}`;
  const outputPath = join(targetPath, fileName);

  await mkdir(targetPath, { recursive: true });
  await writeFile(outputPath, Buffer.from(stripDataUrl(base64), "base64"));

  return { outputPath, mimeType, base64: stripDataUrl(base64) };
}

function parseSseDataBlocks(text: string): unknown[] {
  const events: unknown[] = [];

  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");

    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON SSE data frames.
    }
  }

  return events;
}

async function readImageResponseAndSave(
  response: Response,
  ctx: ExtensionContext,
  params: GenerateImageParamsType,
  onSaved?: (saved: SavedImage) => void,
): Promise<{ payload: unknown; saved: SavedImage }> {
  const saveFirstImageFromPayload = async (payload: unknown, errorLabel: string) => {
    const [imageBase64] = collectImageBase64(payload);
    if (!imageBase64) {
      throw new Error(`${errorLabel} did not contain base64 image data: ${JSON.stringify(payload).slice(0, 1000)}`);
    }

    const savedImage = await saveImageToTarget(ctx, imageBase64, params);
    onSaved?.(savedImage);
    return savedImage;
  };

  if (!response.body) {
    const text = await response.text();
    const payload = text.trimStart().startsWith("event:") || text.trimStart().startsWith("data:")
      ? parseSseDataBlocks(text)
      : JSON.parse(text);
    const saved = await saveFirstImageFromPayload(payload, "Image generation response");
    return { payload, saved };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  let fullText = "";
  let saved: SavedImage | undefined;

  const processChunk = async (chunk: string) => {
    fullText += chunk;
    buffer += chunk;

    const blocks = buffer.split(/\n\n+/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const parsedEvents = parseSseDataBlocks(block);
      for (const event of parsedEvents) {
        events.push(event);

        if (!saved) {
          const [imageBase64] = collectImageBase64(event);
          if (imageBase64) {
            saved = await saveImageToTarget(ctx, imageBase64, params);
            onSaved?.(saved);
          }
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await processChunk(decoder.decode(value, { stream: true }));
  }

  await processChunk(decoder.decode());
  if (buffer.trim()) await processChunk("\n\n");

  if (events.length === 0) {
    let payload: unknown;
    try {
      payload = JSON.parse(fullText);
    } catch {
      throw new Error(`Expected JSON or SSE response but received: ${fullText.slice(0, 500)}`);
    }

    saved = await saveFirstImageFromPayload(payload, "Image generation response");
    return { payload, saved };
  }

  if (!saved) {
    const [imageBase64] = collectImageBase64(events);
    if (imageBase64) {
      saved = await saveImageToTarget(ctx, imageBase64, params);
      onSaved?.(saved);
    }
  }

  if (!saved) {
    throw new Error(`Image generation stream did not contain base64 image data: ${JSON.stringify(events).slice(0, 1000)}`);
  }

  return { payload: events, saved };
}

export default function (pi: ExtensionAPI) {
  let registered = false;

  function registerImageToolIfNeeded() {
    if (registered) return;

    pi.registerTool<typeof GenerateImageParams, GenerateImageDetails>({
      name: TOOL_NAME,
      label: "Generate Image",
      description:
        "Generate an image using the current gpt-5.5+ model's native image_generation tool. " +
        `The API request uses type=${IMAGE_GENERATION_TOOL_TYPE}, model=${IMAGE_MODEL}, caller-controlled size, and target-path save location.`,
      promptSnippet: "Generate images with gpt-image-2 through the current gpt-5.5+ model.",
      promptGuidelines: [
        "Use codex_image when the user asks to create, draw, generate, or render an image.",
        "Pass codex_image a detailed prompt, choose the requested size, and set target-path when the user asks to save in a specific folder.",
      ],
      parameters: GenerateImageParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const model = ctx.model;
        if (!isTargetModel(model)) {
          throw new Error("generate_image is only available for gpt-5.x models where x >= 5.");
        }

        const targetPath = resolveTargetPath(ctx, params);

        onUpdate?.({
          content: [{ type: "text", text: `Requesting ${params.size} image from ${IMAGE_MODEL}...` }],
          details: {
            model: `${model.provider}/${model.id}`,
            imageModel: IMAGE_MODEL,
            size: params.size,
            targetPath,
            outputPath: "",
            mimeType: "image/png",
          },
        });

        const response = await fetch(resolveResponsesUrl(model), {
          method: "POST",
          headers: await buildHeaders(ctx, model),
          body: JSON.stringify(buildRequestBody(model, params)),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Image generation failed (${response.status}): ${errorText.slice(0, 1000)}`);
        }

        const { payload, saved } = await readImageResponseAndSave(response, ctx, params, (savedImage) => {
          onUpdate?.({
            content: [{ type: "text", text: `Image data received and saved to ${savedImage.outputPath}` }],
            details: {
              model: `${model.provider}/${model.id}`,
              imageModel: IMAGE_MODEL,
              size: params.size,
              targetPath,
              outputPath: savedImage.outputPath,
              mimeType: savedImage.mimeType,
            },
          });
        });

        return {
          content: [
            { type: "text", text: `Generated image saved to ${saved.outputPath}` },
            { type: "image", data: saved.base64, mimeType: saved.mimeType },
          ],
          details: {
            model: `${model.provider}/${model.id}`,
            imageModel: IMAGE_MODEL,
            size: params.size,
            targetPath,
            outputPath: saved.outputPath,
            mimeType: saved.mimeType,
            responseId: extractResponseId(payload),
          },
        };
      },
    });

    registered = true;
  }

  function setImageToolActive(active: boolean) {
    const activeTools = pi.getActiveTools();
    const hasTool = activeTools.includes(TOOL_NAME);

    if (active && !hasTool) {
      pi.setActiveTools([...activeTools, TOOL_NAME]);
    } else if (!active && hasTool) {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== TOOL_NAME));
    }
  }

  function syncImageToolForModel(model: Model<any> | undefined) {
    const shouldExposeTool = isTargetModel(model);

    if (shouldExposeTool) {
      registerImageToolIfNeeded();
    }

    setImageToolActive(shouldExposeTool);
  }

  pi.on("session_start", async (_event, ctx) => {
    syncImageToolForModel(ctx.model);
  });

  pi.on("model_select", async (event) => {
    syncImageToolForModel(event.model);
  });
}

/**
 * pi-codex-image-tool
 *
 * Active only while Pi is using a model from the `openai-codex` provider. Adds:
 *
 * - A `codex_image` Pi wrapper tool that calls the current model's Responses
 *   endpoint with OpenAI's image-generation tool configuration:
 *
 *     tools: [{ type: "image_generation", model: "gpt-image-2", size }]
 *     tool_choice: { type: "image_generation" }
 *
 * - A `service_tier` property ('default' | 'priority') injected into every
 *   provider request body. The active tier is shown at the bottom-right of
 *   the footer and can be cycled with alt+shift+tab.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum, Type, type Model, type Static } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";

const TOOL_NAME = "codex_image";
const CODEX_PROVIDER = "openai-codex";
const IMAGE_GENERATION_TOOL_TYPE = "image_generation";
const IMAGE_MODEL = "gpt-image-2";
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const DEFAULT_TARGET_PATH = "/tmp/pi-codex-image-tool";

const SERVICE_TIERS = ["default", "priority"] as const;
type ServiceTier = (typeof SERVICE_TIERS)[number];
const DEFAULT_SERVICE_TIER: ServiceTier = "default";
const SERVICE_TIER_ENTRY_TYPE = "codex-service-tier";
const SERVICE_TIER_FLAG = "codex-service-tier";
const SERVICE_TIER_SHORTCUT = "alt+shift+tab" as const;

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

function isCodexModel(model: Model<any> | undefined): model is Model<any> {
  return model?.provider === CODEX_PROVIDER;
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

function buildRequestBody(model: Model<any>, params: GenerateImageParamsType, serviceTier: ServiceTier) {
  return {
    model: model.id,
    store: false,
    stream: true,
    service_tier: serviceTier,
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

/**
 * Sanitize text for display in a single-line status.
 * Mirrors the built-in footer's status sanitization.
 */
function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

interface FooterDeps {
  getCtx(): ExtensionContext | undefined;
  getModel(): Model<any> | undefined;
  getThinkingLevel(): string;
  getServiceTier(): ServiceTier;
}

/**
 * Replica of Pi's built-in footer (pwd/branch line + stats line) with an extra
 * status line that shows the active service tier at the bottom-right. Pi does
 * not export its FooterComponent, so the layout is ported here.
 */
function renderFooter(
  width: number,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  deps: FooterDeps,
): string[] {
  const ctx = deps.getCtx();
  if (!ctx) return [];

  const model = deps.getModel();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (
      entry.message as {
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          cost?: { total?: number };
        };
      }
    ).usage;
    if (!usage) continue;
    totalInput += usage.input ?? 0;
    totalOutput += usage.output ?? 0;
    totalCacheRead += usage.cacheRead ?? 0;
    totalCacheWrite += usage.cacheWrite ?? 0;
    totalCost += usage.cost?.total ?? 0;
  }

  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
    ? contextPercentValue.toFixed(1)
    : "?";

  let pwd = ctx.sessionManager.getCwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && pwd.startsWith(home)) {
    pwd = `~${pwd.slice(home.length)}`;
  }
  const branch = footerData.getGitBranch();
  if (branch) {
    pwd = `${pwd} (${branch})`;
  }
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) {
    pwd = `${pwd} • ${sessionName}`;
  }

  const statsParts: string[] = [];
  if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

  const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
  if (totalCost || usingSubscription) {
    statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
  }

  const contextPercentDisplay = contextPercent === "?"
    ? `?/${formatTokens(contextWindow)}`
    : `${contextPercent}%/${formatTokens(contextWindow)}`;
  let contextPercentStr: string;
  if (contextPercentValue > 90) {
    contextPercentStr = theme.fg("error", contextPercentDisplay);
  } else if (contextPercentValue > 70) {
    contextPercentStr = theme.fg("warning", contextPercentDisplay);
  } else {
    contextPercentStr = contextPercentDisplay;
  }
  statsParts.push(contextPercentStr);

  let statsLeft = statsParts.join(" ");
  const modelName = model?.id || "no-model";
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const minPadding = 2;
  let rightSideWithoutProvider = modelName;
  if (model?.reasoning) {
    const thinkingLevel = deps.getThinkingLevel() || "off";
    rightSideWithoutProvider =
      thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
  }
  let rightSide = rightSideWithoutProvider;
  if (footerData.getAvailableProviderCount() > 1 && model) {
    rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
    if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
      rightSide = rightSideWithoutProvider;
    }
  }

  const rightSideWidth = visibleWidth(rightSide);
  let statsLine: string;
  if (statsLeftWidth + minPadding + rightSideWidth <= width) {
    statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
  } else {
    const availableForRight = width - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
      statsLine = statsLeft + padding + truncatedRight;
    } else {
      statsLine = statsLeft;
    }
  }

  const dimStatsLeft = theme.fg("dim", statsLeft);
  const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
  const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
  const lines = [pwdLine, dimStatsLeft + dimRemainder];

  // Status line: extension statuses on the left, service tier bottom-right.
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .join(" ");
  const tierStr = theme.fg("dim", "tier: ") + theme.fg("accent", deps.getServiceTier());
  const tierWidth = visibleWidth(tierStr);

  if (tierWidth >= width) {
    lines.push(truncateToWidth(tierStr, width, ""));
  } else {
    const maxLeftWidth = Math.max(0, width - tierWidth - minPadding);
    const left = visibleWidth(statuses) > maxLeftWidth
      ? truncateToWidth(statuses, maxLeftWidth, theme.fg("dim", "..."))
      : statuses;
    lines.push(left + " ".repeat(Math.max(1, width - visibleWidth(left) - tierWidth)) + tierStr);
  }

  return lines;
}

export default function (pi: ExtensionAPI) {
  let registered = false;
  let footerActive = false;
  let serviceTier: ServiceTier = DEFAULT_SERVICE_TIER;
  let currentModel: Model<any> | undefined;
  let currentCtx: ExtensionContext | undefined;
  let footerTui: TUI | undefined;

  const footerDeps: FooterDeps = {
    getCtx: () => currentCtx,
    getModel: () => currentModel,
    getThinkingLevel: () => pi.getThinkingLevel(),
    getServiceTier: () => serviceTier,
  };

  function registerImageToolIfNeeded() {
    if (registered) return;

    pi.registerTool<typeof GenerateImageParams, GenerateImageDetails>({
      name: TOOL_NAME,
      label: "Generate Image",
      description:
        "Generate an image using the current OpenAI Codex model's native image_generation tool. " +
        `The API request uses type=${IMAGE_GENERATION_TOOL_TYPE}, model=${IMAGE_MODEL}, caller-controlled size, and target-path save location.`,
      promptSnippet: "Generate images with gpt-image-2 through the current OpenAI Codex model.",
      promptGuidelines: [
        "Use codex_image when the user asks to create, draw, generate, or render an image.",
        "Pass codex_image a detailed prompt, choose the requested size, and set target-path when the user asks to save in a specific folder.",
      ],
      parameters: GenerateImageParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const model = ctx.model;
        if (!isCodexModel(model)) {
          throw new Error(`${TOOL_NAME} is only available when the active provider is ${CODEX_PROVIDER}.`);
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
          body: JSON.stringify(buildRequestBody(model, params, serviceTier)),
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

  function setFooterActive(active: boolean, ctx: ExtensionContext) {
    if (!ctx.hasUI || active === footerActive) return;

    if (active) {
      ctx.ui.setFooter((tui, theme, footerData) => {
        footerTui = tui;
        const footer: Component & { dispose?(): void } = {
          render: (width: number) => renderFooter(width, theme, footerData, footerDeps),
          invalidate: () => {},
          dispose: () => {
            if (footerTui === tui) footerTui = undefined;
          },
        };
        return footer;
      });
    } else {
      ctx.ui.setFooter(undefined);
    }
    footerActive = active;
  }

  function syncForModel(model: Model<any> | undefined, ctx: ExtensionContext) {
    currentModel = model;
    currentCtx = ctx;
    const active = isCodexModel(model);

    if (active) {
      registerImageToolIfNeeded();
    }

    setImageToolActive(active);
    setFooterActive(active, ctx);
  }

  function restoreServiceTier(ctx: ExtensionContext) {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SERVICE_TIER_ENTRY_TYPE) continue;
      const tier = (entry.data as { tier?: string } | undefined)?.tier;
      if (tier && (SERVICE_TIERS as readonly string[]).includes(tier)) {
        serviceTier = tier as ServiceTier;
      }
    }
  }

  // The --codex-service-tier CLI flag overrides the session-persisted tier.
  function applyServiceTierFlag(ctx: ExtensionContext) {
    const flag = pi.getFlag(SERVICE_TIER_FLAG);
    if (typeof flag !== "string" || flag === "") return;

    if ((SERVICE_TIERS as readonly string[]).includes(flag)) {
      serviceTier = flag as ServiceTier;
    } else if (ctx.hasUI) {
      ctx.ui.notify(
        `Ignoring --${SERVICE_TIER_FLAG} "${flag}". Valid values: ${SERVICE_TIERS.join(", ")}.`,
        "warning",
      );
    }
  }

  pi.registerFlag(SERVICE_TIER_FLAG, {
    description: `OpenAI Codex service tier applied to ${CODEX_PROVIDER} requests (${SERVICE_TIERS.join(" | ")})`,
    type: "string",
  });

  pi.registerShortcut(SERVICE_TIER_SHORTCUT, {
    description: `Cycle OpenAI Codex service tier (${SERVICE_TIERS.join(" → ")})`,
    handler: (ctx) => {
      if (!isCodexModel(ctx.model)) return;

      const index = SERVICE_TIERS.indexOf(serviceTier);
      serviceTier = SERVICE_TIERS[(index + 1) % SERVICE_TIERS.length] ?? DEFAULT_SERVICE_TIER;
      pi.appendEntry(SERVICE_TIER_ENTRY_TYPE, { tier: serviceTier });
      footerTui?.requestRender();
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodexModel(ctx.model)) return;

    const payload = event.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      (payload as Record<string, unknown>).service_tier = serviceTier;
      return payload;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreServiceTier(ctx);
    applyServiceTierFlag(ctx);
    syncForModel(ctx.model, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    syncForModel(event.model, ctx);
  });
}

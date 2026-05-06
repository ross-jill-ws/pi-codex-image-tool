/**
 * pi-codex-image-tool — minimal Pi extension scaffold.
 *
 * Dynamically exposes a `greetings` test tool only while Pi is using a
 * `gpt-5.x` model where x >= 5 (for example gpt-5.5 or gpt-5.10). When another model is selected, the tool is removed from
 * the active tool list so it does not appear in the LLM prompt.
 */

import { Type, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TOOL_NAME = "greetings";
const MIN_TARGET_MODEL_MINOR = 5;
const GREETING_MESSAGE = "Hello, my name is Pi!";

function isGpt5AtLeast55(value: string): boolean {
  const match = value.toLowerCase().match(/(?:^|[^a-z0-9])gpt-5\.(\d+)(?:$|[^\d])/);
  if (!match) return false;

  const minorText = match[1];
  if (!minorText) return false;

  const minor = Number.parseInt(minorText, 10);
  return Number.isFinite(minor) && minor >= MIN_TARGET_MODEL_MINOR;
}

function isTargetModel(model: Model<any> | undefined): boolean {
  if (!model) return false;

  return [model.id, model.name].some(isGpt5AtLeast55);
}

export default function (pi: ExtensionAPI) {
  let registered = false;

  function registerGreetingsToolIfNeeded() {
    if (registered) return;

    pi.registerTool({
      name: TOOL_NAME,
      label: "Greetings",
      description:
        "Testing tool for this Pi extension. Use it when the user's prompt contains keyword 'AAA_greetings'. " +
        `It prints: ${GREETING_MESSAGE}`,
      promptSnippet: "Print the Pi greeting when the user says greetings.",
      promptGuidelines: [
        'Use greetings when the user prompt contains or asks for "greetings".',
      ],
      parameters: Type.Object({}),

      async execute() {
        console.log(GREETING_MESSAGE);

        return {
          content: [{ type: "text" as const, text: GREETING_MESSAGE }],
          details: { message: GREETING_MESSAGE },
        };
      },
    });

    registered = true;
  }

  function setGreetingsToolActive(active: boolean) {
    const activeTools = pi.getActiveTools();
    const hasTool = activeTools.includes(TOOL_NAME);

    if (active && !hasTool) {
      pi.setActiveTools([...activeTools, TOOL_NAME]);
    } else if (!active && hasTool) {
      pi.setActiveTools(activeTools.filter((toolName) => toolName !== TOOL_NAME));
    }
  }

  function syncGreetingsToolForModel(model: Model<any> | undefined) {
    const shouldExposeTool = isTargetModel(model);

    if (shouldExposeTool) {
      registerGreetingsToolIfNeeded();
    }

    setGreetingsToolActive(shouldExposeTool);
  }

  pi.on("session_start", async (_event, ctx) => {
    syncGreetingsToolForModel(ctx.model);
  });

  pi.on("model_select", async (event) => {
    syncGreetingsToolForModel(event.model);
  });
}

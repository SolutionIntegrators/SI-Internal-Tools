// POST /api/chat — Claude with tool use, tools implemented as Worker functions.
//
// This runs the tool loop by hand against the stable Messages API rather than
// using the SDK's beta tool runner: four read-only tools is a small loop, and
// the explicit version lets a failing tool come back as an is_error result the
// model can talk about instead of throwing the whole request away.

import Anthropic from "@anthropic-ai/sdk";
import { json, badRequest, requireVar } from "../lib/http.js";
import { chatSystemPrompt } from "../chat/prompt.js";
import { TOOL_DEFINITIONS, runTool } from "../chat/tools.js";

const MODEL = "claude-opus-5";
const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY_TURNS = 20;

export async function handleChat(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequest("Expected a messages array");
  }

  const client = new Anthropic({ apiKey: requireVar(env, "ANTHROPIC_API_KEY") });
  const messages = body.messages
    .slice(-MAX_HISTORY_TURNS)
    .map((message) => ({ role: message.role, content: message.content }));

  const system = chatSystemPrompt(env, new Date().toISOString());
  const toolsUsed = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages,
      tools: TOOL_DEFINITIONS,
      output_config: { effort: env.CHAT_EFFORT || "medium" },
    });

    if (response.stop_reason === "refusal") {
      return json({ reply: "I can't answer that one.", toolsUsed });
    }

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (toolUses.length === 0) {
      return json({ reply: textOf(response.content), toolsUsed });
    }

    messages.push({ role: "assistant", content: response.content });

    // Tools are independent reads, so run them together and return every
    // result in a single user turn — splitting them teaches Claude to stop
    // asking for parallel calls.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        toolsUsed.push(block.name);
        try {
          const result = await runTool(env, block.name, block.input || {});
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 60000),
          };
        } catch (err) {
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: `Tool failed: ${err.message}`,
            is_error: true,
          };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }

  return json({
    reply: "I went back and forth with your tools a few times without landing on an answer. Try narrowing the question.",
    toolsUsed,
  });
}

function textOf(content) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

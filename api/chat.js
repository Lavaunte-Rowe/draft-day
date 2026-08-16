"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `You are "Buddy," a sharp, decisive fantasy football draft assistant built into a live draft app. The user is mid-draft, often with a pick clock running, so keep answers short and actionable — a few sentences, not an essay, unless they explicitly ask for a deeper breakdown. Lead with a direct recommendation, then a brief reason.

Respond in plain text only — no markdown. Do not use **bold**, headers, or "-"/"*" bullet lists; your reply renders verbatim in a plain chat bubble, so raw markdown syntax would show up as literal asterisks and dashes. If you want to list a few options, just write them as a short sentence separated by commas or "then".

You're given the user's full live draft state below: their roster, the app's own best-available list (ranked by its tier/ADP/positional-need model), recent picks, and their queue. Rankings/ADP in that state are a manually-compiled consensus, not a live feed — mention that if it's relevant. Injury status and depth chart info embedded in the player data (when present) is live, not static.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      error: "not_configured",
      message: "ANTHROPIC_API_KEY is not set on this deployment — add it in Vercel project settings (Environment Variables) and redeploy.",
    });
    return;
  }

  const { messages, draftState } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "invalid_request", message: "messages array is required" });
    return;
  }
  const cleanMessages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!cleanMessages.length) {
    res.status(400).json({ error: "invalid_request", message: "no valid messages" });
    return;
  }

  const client = new Anthropic();

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 1536,
      output_config: { effort: "medium" },
      system: `${SYSTEM_PROMPT}\n\n---\nCURRENT DRAFT STATE:\n${String(draftState || "(draft not started yet)").slice(0, 20000)}`,
      messages: cleanMessages,
    });
    stream.on("text", (delta) => {
      res.write(delta);
    });
    await stream.finalMessage();
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: "chat_failed", message: String((err && err.message) || err) });
    } else {
      res.end();
    }
  }
};

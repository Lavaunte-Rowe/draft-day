"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `You are "Buddy," a sharp, decisive fantasy football draft assistant built into a live draft app. The user is mid-draft, often with a pick clock running, so keep answers short and actionable — a few sentences, not an essay, unless they explicitly ask for a deeper breakdown. Lead with a direct recommendation, then a brief reason.

Respond in plain prose only — never use markdown syntax of any kind: no **asterisks** for bold, no numbered lists ("1.", "2."), no dashed/bulleted lists, no headers, no underscores for italics. Your reply renders verbatim in a plain chat bubble with no markdown rendering, so any markdown syntax shows up as literal asterisks, dashes, and numbers. Write the way you'd text a friend: normal sentences and paragraphs. If you want to mention a couple of options, weave them into a sentence — e.g. "Take Bijan Robinson if he's there, otherwise Jahmyr Gibbs" — never a numbered or dashed list. Never start a line with a digit, dash, or asterisk.

You're given the user's full live draft state below: their roster, the app's own best-available list (ranked by its tier/ADP/positional-need model), recent picks, and their queue. Tier and positional rank in that state are a manually-compiled consensus, not a live feed — mention that if it's relevant. ADP is live, pulled daily from real drafts, except for deep bench players with no live draft volume, where it falls back to the consensus number. Injury status and depth chart info embedded in the player data (when present) is live, not static.

You have real web search — use it when a question actually needs something outside the draft state: breaking news, an injury update from the last day or two, a beat-writer report, a coaching change, anything time-sensitive. Don't search for things the draft state already answers (rankings, ADP, who's been drafted, roster construction) — that just adds latency for no benefit. When you do search, weave what you find into the same short, plain-prose answer — no citation lists, no "according to X" formality, just fold it in naturally like you already knew it.`;

const HOT_TAKES_SUFFIX = `\n\nHot takes mode is ON: be more opinionated and blunt. Don't hedge, don't say "it depends" — pick a side and defend it. Still plain prose, still short.`;

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

  const { messages, draftState, hotTakes } = req.body || {};
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

  const system = `${SYSTEM_PROMPT}${hotTakes === true ? HOT_TAKES_SUFFIX : ""}\n\n---\nCURRENT DRAFT STATE:\n${String(draftState || "(draft not started yet)").slice(0, 20000)}`;
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];

  try {
    let turnMessages = cleanMessages;
    // A long-running search turn can stop with stop_reason "pause_turn" instead
    // of finishing — resume it (bounded) rather than silently truncating.
    for (let round = 0; round < 3; round++) {
      const stream = client.messages.stream({
        model: "claude-opus-5",
        max_tokens: 1536,
        output_config: { effort: "medium" },
        system,
        tools,
        messages: turnMessages,
      });
      stream.on("text", (delta) => {
        res.write(delta);
      });
      const finalMsg = await stream.finalMessage();
      if (finalMsg.stop_reason !== "pause_turn") break;
      turnMessages = [...turnMessages, { role: "assistant", content: finalMsg.content }];
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: "chat_failed", message: String((err && err.message) || err) });
    } else {
      res.end();
    }
  }
};

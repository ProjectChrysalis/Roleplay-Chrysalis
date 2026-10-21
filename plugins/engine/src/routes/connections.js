import { llmFailReason } from "../passes.js";

export function connectionsRoute(c) {
  const { req, host, head, id, op, ok, err, body } = c;
  if (head !== "connections" || id !== "test" || op || req.method !== "POST") return;
  const model = typeof body().model === "string" ? body().model.trim() : "";
  if (!model || !model.includes("/")) return err(400, "Select a model first");
  const reply = host.llm.results.connectionTest;
  if (!reply) {
    host.llm.request("connectionTest", {
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      reasoning: "off",
      presetParams: { max_tokens: 256 },
    });
    return { __llmPending: true };
  }
  if (reply.model === "error") return err(503, llmFailReason(reply));
  const text = typeof reply.text === "string" ? reply.text.trim() : "";
  if (!text) return err(502, "Model returned no reply");
  return ok({ text, model: reply.model });
}

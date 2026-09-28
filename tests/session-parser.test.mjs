import test from "node:test";
import assert from "node:assert/strict";
import { parseSessionText } from "../scripts/session-parser.mjs";

const line = (type, payload, timestamp) => JSON.stringify({ type, payload, timestamp });

test("parses Codex input, model, tool and usage events", () => {
  const ms = (value) => Date.parse(`2026-09-02T00:00:0${value}Z`);
  const source = [
    line("session_meta", { id: "11111111-1111-4111-8111-111111111111", cwd: "C:\\work", base_instructions: "system" }, "2026-09-02T00:00:00Z"),
    line("event_msg", { type: "task_started", turn_id: "turn-a" }, "2026-09-02T00:00:01Z"),
    line("turn_context", { turn_id: "turn-a", model: "gpt-test", cwd: "C:\\work" }, "2026-09-02T00:00:02Z"),
    line("event_msg", { type: "item_completed", item: { type: "UserMessage", content: "hello" } }, "2026-09-02T00:00:03Z"),
    line("event_msg", { type: "item_completed", item: { type: "Reasoning", summary_text: "thinking" }, started_at_ms: ms(3), completed_at_ms: ms(4) }, "2026-09-02T00:00:04Z"),
    line("event_msg", { type: "item_completed", item: { type: "AgentMessage", content: "answer", phase: "commentary" }, started_at_ms: ms(4), completed_at_ms: ms(5) }, "2026-09-02T00:00:05Z"),
    line("event_msg", { type: "item_completed", item: { type: "CommandExecution", id: "cmd-1", command: "pwd", cwd: "C:\\work", stdout: "C:\\work", exit_code: 0, status: "completed" }, started_at_ms: ms(5), completed_at_ms: ms(5) + 600 }, "2026-09-02T00:00:05.600Z"),
    line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 7 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, total_tokens: 120 } } }, "2026-09-02T00:00:06Z"),
    line("event_msg", { type: "task_complete", turn_id: "turn-a", duration_ms: 5000 }, "2026-09-02T00:00:06Z"),
  ].join("\n");

  const parsed = parseSessionText(source);
  assert.equal(parsed.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(parsed.model, "gpt-test");
  assert.equal(parsed.totalTurns, 1);
  assert.equal(parsed.modelCalls, 1);
  assert.equal(parsed.toolCalls, 1);
  assert.equal(parsed.totalUsage.total_tokens, 120);
  assert.ok(parsed.turns[0].events.some((event) => event.label === "USER"));
  assert.ok(parsed.turns[0].events.some((event) => event.label === "TOOL"));
  assert.ok(!parsed.turns[0].events.some((event) => event.label === "MODEL"));
  const assistant = parsed.turns[0].events.find((event) => event.label === "ASSISTANT");
  assert.equal(assistant.requestNumber, 1);
  assert.equal(assistant.previewText, "answer");
  assert.equal(assistant.thinkingText, "thinking");
  assert.equal(assistant.tokenTotal, 20);
  assert.equal(assistant.reasoningTokens, 7);
  assert.equal(assistant.contentTokens, 13);
  assert.equal(assistant.linkedTools.length, 1);
  assert.equal(assistant.metrics.derived, true);
  const tool = parsed.turns[0].events.find((event) => event.label === "TOOL");
  assert.equal(tool.toolName, "exec_command");
  assert.equal(tool.durationMs, 600);
  assert.equal(tool.isError, false);
  assert.equal(tool.parentRequestNumber, 1);
  assert.equal(tool.parentAssistantId, assistant.id);
  assert.match(tool.payloadText, /"command": "pwd"/);
  assert.match(tool.resultText, /"exit_code": 0/);
  assert.match(tool.schemaText, /"inferred": true/);
  assert.match(tool.sourceText, /"item_id": "cmd-1"/);
  assert.match(tool.rawText, /"item_completed"/);
  assert.equal(tool.turnNumber, 1);
  assert.ok(tool.eventNumber > 0);
});

test("marks failed tools for the red inspector state", () => {
  const source = [
    line("event_msg", { type: "task_started", turn_id: "turn-b" }, "2026-09-02T00:00:00Z"),
    line("event_msg", { type: "item_completed", turn_id: "turn-b", item: { type: "CommandExecution", command: "exit 1", status: "failed", exit_code: 1, stderr: "boom" } }, "2026-09-02T00:00:01Z"),
  ].join("\n");
  const failed = parseSessionText(source).turns[0].events.find((event) => event.label === "TOOL");
  assert.equal(failed.status, "failed");
  assert.equal(failed.isError, true);
  assert.match(failed.resultText, /boom/);
});

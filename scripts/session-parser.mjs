import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function textFromContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(textFromContent).filter(Boolean).join("\n\n");
  }
  if (typeof value === "object") {
    for (const key of ["text", "content", "summary_text", "raw_content", "output", "formatted_output"]) {
      if (value[key] != null) {
        const result = textFromContent(value[key]);
        if (result) return result;
      }
    }
    return safeJson(value);
  }
  return String(value);
}

function clip(value, limit = 16000) {
  const text = textFromContent(value).replace(/\u0000/g, "");
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n\n… 已截断 ${text.length - limit} 个字符`, truncated: true };
}

function clipText(value, limit) {
  return clip(value, limit).text;
}

function durationMilliseconds(item, startedMs, completedMs) {
  if (Number.isFinite(startedMs) && Number.isFinite(completedMs)) {
    return Math.max(0, completedMs - startedMs);
  }
  if (typeof item?.duration === "number" && Number.isFinite(item.duration)) return item.duration;
  if (item?.duration && typeof item.duration === "object") {
    const seconds = Number(item.duration.secs || 0);
    const nanos = Number(item.duration.nanos || 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return seconds * 1000 + nanos / 1_000_000;
  }
  return 0;
}

function sourceDetail(record, item) {
  const payload = record?.payload || {};
  return {
    log_record: record?.type || "unknown",
    ordinal: record?.ordinal,
    event_type: payload.type,
    item_type: item?.type,
    item_id: item?.id,
    thread_id: payload.thread_id,
    turn_id: payload.turn_id || item?.internal_chat_message_metadata_passthrough?.turn_id,
    phase: item?.phase,
  };
}

function schemaNode(value, depth = 0) {
  if (depth > 4) return {};
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? schemaNode(value[0], depth + 1) : {} };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, schemaNode(child, depth + 1)])),
      additionalProperties: true,
    };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: typeof value };
}

function inferredSchema(name, payload) {
  return {
    name,
    description: "Codex 会话日志未保存注册时的工具说明；此 Schema 根据本次实际调用参数推断。",
    parameters: schemaNode(payload),
    inferred: true,
  };
}

function toolInspection(type, item) {
  switch (type) {
    case "CommandExecution": {
      const payload = {
        command: item.command,
        cwd: item.cwd,
        parsed_cmd: item.parsed_cmd,
        source: item.source,
        process_id: item.process_id,
      };
      return {
        toolName: "exec_command",
        payload,
        result: {
          status: item.status,
          exit_code: item.exit_code,
          stdout: item.stdout,
          stderr: item.stderr,
          aggregated_output: item.aggregated_output,
          formatted_output: item.formatted_output,
        },
        schema: inferredSchema("exec_command", payload),
      };
    }
    case "McpToolCall": {
      const payload = { server: item.server, tool: item.tool, arguments: item.arguments };
      return {
        toolName: `${item.server ? `${item.server}.` : ""}${item.tool || "mcp_tool"}`,
        payload,
        result: item.result,
        schema: inferredSchema(item.tool || "mcp_tool", item.arguments || {}),
      };
    }
    case "Extension": {
      const payload = { kind: item.kind, query: item.query, action: item.action };
      return {
        toolName: item.kind || "extension",
        payload,
        result: item.results,
        schema: inferredSchema(item.kind || "extension", payload),
      };
    }
    case "FileChange": {
      const payload = { changes: item.changes };
      return {
        toolName: "apply_patch",
        payload,
        result: { status: item.status, stdout: item.stdout, stderr: item.stderr },
        schema: inferredSchema("apply_patch", payload),
      };
    }
    case "ImageView": {
      const payload = { path: item.path };
      return { toolName: "view_image", payload, result: { status: item.status || "completed" }, schema: inferredSchema("view_image", payload) };
    }
    default: {
      const payload = Object.fromEntries(Object.entries(item || {}).filter(([key]) => !["type", "id", "status", "result", "stdout", "stderr", "formatted_output", "aggregated_output"].includes(key)));
      const result = item?.result ?? {
        status: item?.status,
        stdout: item?.stdout,
        stderr: item?.stderr,
        formatted_output: item?.formatted_output,
      };
      return { toolName: type || "tool", payload, result, schema: inferredSchema(type || "tool", payload) };
    }
  }
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return String(number);
}

function asTimestamp(record, fallbackMs = null) {
  if (Number.isFinite(fallbackMs)) return new Date(fallbackMs).toISOString();
  const value = record?.timestamp;
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

function eventSummary(type, item) {
  switch (type) {
    case "CommandExecution":
      return textFromContent(item.command || item.parsed_cmd || "命令执行").replace(/\s+/g, " ").slice(0, 180);
    case "McpToolCall":
      return `${item.server ? `${item.server} · ` : ""}${item.tool || "MCP 工具"}`;
    case "Extension":
      return `${item.kind || "扩展"}${typeof item.query === "string" && item.query ? ` · ${item.query}` : ""}`;
    case "FileChange":
      return `文件修改${Array.isArray(item.changes) ? ` · ${item.changes.length} 项` : ""}`;
    case "Reasoning":
      return textFromContent(item.summary_text || item.raw_content || "模型推理").replace(/\s+/g, " ").slice(0, 180) || "模型推理";
    case "AgentMessage":
      return textFromContent(item.content).replace(/\s+/g, " ").slice(0, 180) || "助手消息";
    case "UserMessage":
      return textFromContent(item.content).replace(/\s+/g, " ").slice(0, 180) || "用户消息";
    default:
      return type || "事件";
  }
}

function itemDetail(type, item) {
  switch (type) {
    case "CommandExecution":
      return [
        item.command ? `命令\n${textFromContent(item.command)}` : "",
        item.cwd ? `目录\n${item.cwd}` : "",
        item.status ? `状态\n${item.status}${item.exit_code != null ? ` · exit ${item.exit_code}` : ""}` : "",
        item.stdout ? `标准输出\n${textFromContent(item.stdout)}` : "",
        item.stderr ? `错误输出\n${textFromContent(item.stderr)}` : "",
        !item.stdout && !item.stderr && item.formatted_output ? textFromContent(item.formatted_output) : "",
      ].filter(Boolean).join("\n\n");
    case "McpToolCall":
      return [
        `工具\n${item.server ? `${item.server}.` : ""}${item.tool || "unknown"}`,
        item.arguments != null ? `参数\n${safeJson(item.arguments)}` : "",
        item.result != null ? `结果\n${textFromContent(item.result)}` : "",
        item.status ? `状态\n${item.status}` : "",
      ].filter(Boolean).join("\n\n");
    case "Extension":
      return safeJson({ kind: item.kind, query: item.query, action: item.action, results: item.results });
    case "FileChange":
      return [safeJson(item.changes || []), textFromContent(item.stdout), textFromContent(item.stderr)].filter(Boolean).join("\n\n");
    case "Reasoning":
      return textFromContent(item.raw_content || item.summary_text);
    case "AgentMessage":
    case "UserMessage":
      return textFromContent(item.content);
    default:
      return safeJson(item);
  }
}

function laneForItem(type) {
  if (type === "UserMessage") return { lane: "input", label: "USER", kind: "user" };
  if (type === "AgentMessage") return { lane: "model", label: "ASSISTANT", kind: "assistant" };
  if (type === "Reasoning") return { lane: "model", label: "REASONING", kind: "reasoning" };
  return { lane: "tools", label: "TOOL", kind: type || "tool" };
}

export function parseSessionText(source, options = {}) {
  const maxEvents = options.maxEvents ?? 700;
  const maxText = options.maxText ?? 16000;
  const records = [];
  for (const line of String(source || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore a trailing partial record while a live session is being written.
    }
  }

  let sessionId = "";
  let projectDir = "";
  let model = "";
  let startedAt = "";
  let endedAt = "";
  let activeTurn = "0";
  let modelCallCount = 0;
  let toolCallCount = 0;
  let totalUsage = {};
  let systemPrompt = "";
  const turns = new Map();
  const prelude = [];
  let pendingRequest = null;
  let lastClosedRequest = null;
  let lastBoundaryMs = null;
  let runtimeContextEvent = null;

  const ensureTurn = (turnId) => {
    const id = String(turnId || activeTurn || "0");
    if (!turns.has(id)) {
      turns.set(id, { id, startedAt: "", endedAt: "", durationMs: 0, events: [] });
    }
    return turns.get(id);
  };

  const push = (turnId, event) => {
    const target = turnId ? ensureTurn(turnId).events : prelude;
    const stableId = event.recordId || `${event.kind}-${turnId || "prelude"}-${target.length + 1}-${event.timestamp}`;
    target.push({ id: stableId, ...event });
    return target[target.length - 1];
  };

  const ensureRequest = (turnId, timestamp) => {
    const id = String(turnId || activeTurn || "0");
    if (pendingRequest && pendingRequest.turnId !== id) finalizeRequest(null, timestamp);
    if (!pendingRequest) {
      const at = Date.parse(timestamp);
      pendingRequest = {
        turnId: id,
        startedMs: Number.isFinite(lastBoundaryMs) ? lastBoundaryMs : (Number.isFinite(at) ? at : Date.now()),
        firstTokenMs: null,
        completedMs: null,
        reasoning: [],
        messages: [],
        tools: [],
        raw: [],
        customCalls: [],
      };
    }
    return pendingRequest;
  };

  const finalizeRequest = (tokenPayload, timestamp) => {
    if (!pendingRequest) return null;
    const request = pendingRequest;
    pendingRequest = null;
    const usage = tokenPayload?.info?.last_token_usage || {};
    const tokenMs = Date.parse(timestamp);
    const firstToolMs = request.tools
      .map((event) => Date.parse(event.startedAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const completedMs = Number.isFinite(firstToolMs)
      ? firstToolMs
      : (Number.isFinite(request.completedMs) ? request.completedMs : tokenMs);
    const firstTokenMs = Number.isFinite(request.firstTokenMs) ? request.firstTokenMs : null;
    const startedMs = Math.min(request.startedMs, firstTokenMs ?? request.startedMs);
    const safeCompletedMs = Number.isFinite(completedMs) ? Math.max(startedMs, completedMs) : startedMs;
    const totalMs = Math.max(0, safeCompletedMs - startedMs);
    const ttftMs = firstTokenMs == null ? null : Math.max(0, firstTokenMs - startedMs);
    const generationMs = firstTokenMs == null ? null : Math.max(0, safeCompletedMs - firstTokenMs);
    const outputTokens = Number(usage.output_tokens || 0);
    const reasoningTokens = Number(usage.reasoning_output_tokens || 0);
    const contentTokens = Math.max(0, outputTokens - reasoningTokens);
    const outputText = request.messages.map((entry) => entry.text).filter(Boolean).join("\n\n");
    const thinkingText = request.reasoning.map((entry) => entry.text).filter(Boolean).join("\n\n");
    modelCallCount += 1;
    const assistantId = `request-${modelCallCount}-assistant`;
    const linkedTools = request.tools.map((event) => ({
      id: event.recordId,
      name: event.toolName,
      summary: event.summary,
      status: event.status,
      isError: event.isError,
    }));
    const summary = outputText.replace(/\s+/g, " ").trim().slice(0, 220)
      || thinkingText.replace(/\s+/g, " ").trim().slice(0, 220)
      || (linkedTools.length ? `调用 ${linkedTools.length} 个工具` : `模型请求 #${modelCallCount}`);
    const rawText = clipText(request.raw, maxText);
    const assistant = push(request.turnId, {
      recordId: assistantId,
      timestamp: new Date(safeCompletedMs).toISOString(),
      startedAt: new Date(startedMs).toISOString(),
      completedAt: new Date(safeCompletedMs).toISOString(),
      lane: "model",
      label: "ASSISTANT",
      kind: "assistant",
      itemType: "AssistantRequest",
      requestNumber: modelCallCount,
      summary,
      detail: outputText || thinkingText,
      previewText: outputText,
      thinkingText,
      rawText,
      durationMs: totalMs,
      status: "completed",
      usage,
      tokenTotal: outputTokens,
      reasoningTokens,
      contentTokens,
      linkedTools,
      metrics: {
        startedAt: new Date(startedMs).toISOString(),
        completedAt: new Date(safeCompletedMs).toISOString(),
        totalMs,
        ttftMs,
        generationMs,
        throughput: generationMs > 0 ? outputTokens / (generationMs / 1000) : null,
        derived: true,
        source: "Codex session events",
      },
    });
    for (const tool of request.tools) {
      tool.parentRequestNumber = modelCallCount;
      tool.parentAssistantId = assistant.id;
      push(request.turnId, tool);
    }
    lastClosedRequest = { requestNumber: modelCallCount, assistant, turnId: request.turnId };
    if (Number.isFinite(tokenMs)) lastBoundaryMs = tokenMs;
    return assistant;
  };

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = { ...records[recordIndex], ordinal: recordIndex + 1 };
    const payload = record?.payload || {};
    const timestamp = asTimestamp(record);
    if (!startedAt) startedAt = timestamp;
    endedAt = timestamp;

    if (record.type === "session_meta") {
      sessionId = payload.id || payload.session_id || sessionId;
      projectDir = payload.cwd || projectDir;
      const base = clip(payload.base_instructions, maxText);
      systemPrompt = base.text;
      lastBoundaryMs = Date.parse(timestamp);
      if (systemPrompt) {
        push(null, {
          recordId: `record-${record.ordinal}-system`,
          timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          lane: "input",
          label: "SYSTEM",
          kind: "system",
          itemType: "SystemPrompt",
          summary: "Initial System Prompt",
          detail: systemPrompt,
          previewText: systemPrompt,
          sourceText: clipText(sourceDetail(record), maxText),
          rawText: clipText(record, maxText),
          status: "completed",
          truncated: base.truncated,
        });
      }
      continue;
    }

    if (record.type === "turn_context") {
      activeTurn = String(payload.turn_id || activeTurn || "0");
      model = payload.model || model;
      projectDir = payload.cwd || projectDir;
      const context = {
        cwd: payload.cwd,
        workspace_roots: payload.workspace_roots,
        current_date: payload.current_date,
        timezone: payload.timezone,
        approval_policy: payload.approval_policy,
        sandbox_policy: payload.sandbox_policy,
        model: payload.model,
        effort: payload.effort,
        collaboration_mode: payload.collaboration_mode,
        summary: payload.summary,
      };
      const detail = clip(context, maxText);
      push(activeTurn, {
        recordId: `record-${record.ordinal}-context`,
        timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        lane: "input",
        label: "CONTEXT",
        kind: "context",
        itemType: "TurnContext",
        summary: `运行上下文 · ${payload.model || "Codex"}`,
        detail: detail.text,
        previewText: detail.text,
        sourceText: clipText(sourceDetail(record), maxText),
        rawText: clipText(record, maxText),
        status: "completed",
        truncated: detail.truncated,
      });
      lastBoundaryMs = Date.parse(timestamp);
      continue;
    }

    if (record.type === "response_item" && (payload.role === "developer" || payload.role === "system")) {
      const detail = clip(payload.content, maxText);
      if (!runtimeContextEvent) {
        runtimeContextEvent = push(null, {
          recordId: `record-${record.ordinal}-runtime-input`,
          timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          lane: "input",
          label: "CONTEXT",
          kind: "developer",
          itemType: "RuntimeMessages",
          summary: "Developer / Runtime 输入",
          detail: detail.text,
          previewText: detail.text,
          sourceText: clipText(sourceDetail(record), maxText),
          rawText: clipText(record, maxText),
          status: "completed",
          truncated: detail.truncated,
          partCount: 1,
        });
      } else {
        runtimeContextEvent.partCount += 1;
        runtimeContextEvent.summary = `Developer / Runtime 输入 · ${runtimeContextEvent.partCount} 个片段`;
        runtimeContextEvent.detail = clipText(`${runtimeContextEvent.detail}\n\n---\n\n${detail.text}`, maxText);
        runtimeContextEvent.previewText = runtimeContextEvent.detail;
        runtimeContextEvent.rawText = clipText(`${runtimeContextEvent.rawText}\n${clipText(record, maxText)}`, maxText);
        runtimeContextEvent.completedAt = timestamp;
        runtimeContextEvent.timestamp = timestamp;
        runtimeContextEvent.truncated ||= detail.truncated;
      }
      continue;
    }

    if (record.type === "response_item" && ["custom_tool_call", "function_call"].includes(payload.type)) {
      const request = ensureRequest(activeTurn, timestamp);
      let input = payload.input || payload.arguments || "";
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { /* Keep the original string. */ }
      }
      request.customCalls.push({ name: payload.name || "tool", callId: payload.call_id, input });
      request.raw.push(record);
      continue;
    }

    if (record.type !== "event_msg") continue;

    if (payload.type === "task_started") {
      activeTurn = String(payload.turn_id || activeTurn || "0");
      const turn = ensureTurn(activeTurn);
      turn.startedAt = payload.started_at || timestamp;
      lastBoundaryMs = Date.parse(turn.startedAt) || Date.parse(timestamp);
      continue;
    }

    if (payload.type === "task_complete") {
      finalizeRequest(null, timestamp);
      activeTurn = String(payload.turn_id || activeTurn || "0");
      const turn = ensureTurn(activeTurn);
      turn.endedAt = payload.completed_at || timestamp;
      turn.durationMs = Number(payload.duration_ms || 0);
      continue;
    }

    if (payload.type === "token_count") {
      const usage = payload.info?.last_token_usage || {};
      totalUsage = payload.info?.total_token_usage || totalUsage;
      if (pendingRequest) {
        pendingRequest.raw.push(record);
        finalizeRequest(payload, timestamp);
      } else {
        const at = Date.parse(timestamp);
        if (Number.isFinite(at)) lastBoundaryMs = at;
      }
      continue;
    }

    if (payload.type !== "item_completed" || !payload.item) continue;
    const item = payload.item;
    const itemType = String(item.type || "Unknown");
    if (itemType === "UserMessage") {
      const detail = clip(itemDetail(itemType, item), maxText);
      push(payload.turn_id || activeTurn, {
        recordId: `record-${record.ordinal}-${item.id || itemType}`,
        timestamp: asTimestamp(record, Number(payload.completed_at_ms)),
        startedAt: asTimestamp(record, Number(payload.started_at_ms)),
        completedAt: asTimestamp(record, Number(payload.completed_at_ms)),
        lane: "input", label: "USER", kind: "user", itemType,
        summary: eventSummary(itemType, item), detail: detail.text, previewText: detail.text,
        sourceText: clipText(sourceDetail(record, item), maxText), rawText: clipText(record, maxText),
        durationMs: 0, status: "completed", truncated: detail.truncated,
      });
      const at = Number(payload.completed_at_ms);
      if (Number.isFinite(at)) lastBoundaryMs = at;
      continue;
    }
    if (itemType === "Reasoning" || itemType === "AgentMessage") {
      const request = ensureRequest(payload.turn_id || activeTurn, timestamp);
      const started = Number(payload.started_at_ms);
      const completed = Number(payload.completed_at_ms);
      if (Number.isFinite(started)) request.firstTokenMs = request.firstTokenMs == null ? started : Math.min(request.firstTokenMs, started);
      if (Number.isFinite(completed)) request.completedMs = request.completedMs == null ? completed : Math.max(request.completedMs, completed);
      const text = itemType === "Reasoning"
        ? textFromContent(item.raw_content || item.summary_text)
        : textFromContent(item.content);
      const entry = { text, phase: item.phase, startedMs: started, completedMs: completed };
      if (itemType === "Reasoning") request.reasoning.push(entry); else request.messages.push(entry);
      request.raw.push(record);
      continue;
    }
    if (itemType === "ContextCompaction") {
      const detail = clip(itemDetail(itemType, item), maxText);
      push(payload.turn_id || activeTurn, {
        recordId: `record-${record.ordinal}-${item.id || itemType}`,
        timestamp: asTimestamp(record, Number(payload.completed_at_ms)),
        startedAt: asTimestamp(record, Number(payload.started_at_ms)),
        completedAt: asTimestamp(record, Number(payload.completed_at_ms)),
        lane: "input", label: "CONTEXT", kind: "context", itemType,
        summary: "上下文压缩", detail: detail.text, previewText: detail.text,
        sourceText: clipText(sourceDetail(record, item), maxText), rawText: clipText(record, maxText),
        durationMs: durationMilliseconds(item, Number(payload.started_at_ms), Number(payload.completed_at_ms)),
        status: item.status || "completed", truncated: detail.truncated,
      });
      continue;
    }
    const meta = laneForItem(itemType);
    toolCallCount += 1;
    const detail = clip(itemDetail(itemType, item), maxText);
    const startedMs = Number(payload.started_at_ms);
    const completedMs = Number(payload.completed_at_ms);
    const inspection = meta.lane === "tools" ? toolInspection(itemType, item) : null;
    const isError = item.status === "failed"
      || (item.exit_code != null && Number(item.exit_code) !== 0)
      || item.result?.isError === true;
    const durationMs = durationMilliseconds(item, startedMs, completedMs);
    const toolEvent = {
      recordId: `record-${record.ordinal}-${item.id || itemType}`,
      timestamp: asTimestamp(record, Number.isFinite(completedMs) ? completedMs : null),
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : timestamp,
      completedAt: Number.isFinite(completedMs) ? new Date(completedMs).toISOString() : timestamp,
      lane: meta.lane,
      label: meta.label,
      kind: meta.kind,
      itemType,
      toolName: inspection?.toolName || "",
      summary: eventSummary(itemType, item),
      detail: detail.text,
      previewText: meta.lane === "tools" ? "" : detail.text,
      payloadText: inspection ? clipText(inspection.payload, maxText) : "",
      resultText: inspection ? clipText(inspection.result, maxText) : "",
      schemaText: inspection ? clipText(inspection.schema, maxText) : "",
      sourceText: clipText(sourceDetail(record, item), maxText),
      rawText: clipText(record, maxText),
      durationMs,
      status: isError ? "failed" : (item.status || "completed"),
      isError,
      truncated: detail.truncated,
    };
    if (!pendingRequest && lastClosedRequest && lastClosedRequest.turnId === String(payload.turn_id || activeTurn || "0")) {
      toolEvent.parentRequestNumber = lastClosedRequest.requestNumber;
      toolEvent.parentAssistantId = lastClosedRequest.assistant.id;
      lastClosedRequest.assistant.linkedTools.push({ id: toolEvent.recordId, name: toolEvent.toolName, summary: toolEvent.summary, status: toolEvent.status, isError: toolEvent.isError });
      push(payload.turn_id || activeTurn, toolEvent);
    } else {
      const request = ensureRequest(payload.turn_id || activeTurn, timestamp);
      request.tools.push(toolEvent);
      request.raw.push(record);
    }
  }

  finalizeRequest(null, endedAt || new Date().toISOString());

  const orderedTurns = [...turns.values()]
    .sort((a, b) => {
      const an = Number(a.id);
      const bn = Number(b.id);
      return Number.isFinite(an) && Number.isFinite(bn) ? an - bn : a.id.localeCompare(b.id);
    })
    .map((turn, index) => ({
      ...turn,
      number: index + 1,
      events: turn.events.map((event, eventIndex) => ({
        ...event,
        turnId: turn.id,
        turnNumber: index + 1,
        eventNumber: eventIndex + 1,
      })),
    }));

  for (let index = 0; index < prelude.length; index += 1) {
    prelude[index] = { ...prelude[index], turnId: null, turnNumber: null, eventNumber: index + 1 };
  }

  const allEvents = [...prelude, ...orderedTurns.flatMap((turn) => turn.events)];
  const limited = allEvents.length > maxEvents;
  if (limited) {
    let remaining = maxEvents;
    const preludeLimit = Math.min(prelude.length, remaining);
    prelude.splice(preludeLimit);
    remaining -= prelude.length;
    for (const turn of orderedTurns) {
      if (remaining <= 0) turn.events = [];
      else if (turn.events.length > remaining) turn.events = turn.events.slice(0, remaining);
      remaining -= turn.events.length;
    }
  }

  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  const elapsedMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;

  return {
    sessionId,
    projectDir,
    model,
    startedAt,
    endedAt,
    elapsedMs,
    totalTurns: orderedTurns.length,
    modelCalls: modelCallCount,
    toolCalls: toolCallCount,
    totalUsage,
    prelude,
    turns: orderedTurns,
    limited,
    sourceRecords: records.length,
  };
}

export function parseSessionFile(filePath, options = {}) {
  const parsed = parseSessionText(fs.readFileSync(filePath, "utf8"), options);
  return { ...parsed, sourcePath: filePath };
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s*[—–|-]\s*Codex.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function walkJsonl(root, output) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const match = entry.name.match(UUID_RE);
        if (match) output.set(match[0].toLowerCase(), full);
      }
    }
  }
}

export class SessionCatalog {
  constructor(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
    this.codexHome = codexHome;
    this.indexPath = path.join(codexHome, "session_index.jsonl");
    this.fileById = new Map();
    this.entries = [];
    this.indexMtime = 0;
    this.filesScanned = false;
  }

  refreshIndex(force = false) {
    let stat;
    try {
      stat = fs.statSync(this.indexPath);
    } catch {
      this.entries = [];
      return;
    }
    if (!force && stat.mtimeMs === this.indexMtime) return;
    this.indexMtime = stat.mtimeMs;
    const byId = new Map();
    for (const line of fs.readFileSync(this.indexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row.id) continue;
        byId.set(String(row.id).toLowerCase(), {
          id: String(row.id),
          title: String(row.thread_name || ""),
          normalizedTitle: normalizeTitle(row.thread_name),
          updatedAt: String(row.updated_at || ""),
        });
      } catch {
        // Ignore a trailing partial row.
      }
    }
    this.entries = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  scanFiles(force = false) {
    if (this.filesScanned && !force) return;
    const next = new Map();
    walkJsonl(path.join(this.codexHome, "archived_sessions"), next);
    walkJsonl(path.join(this.codexHome, "sessions"), next);
    this.fileById = next;
    this.filesScanned = true;
  }

  resolve(context = {}) {
    this.refreshIndex();
    this.scanFiles();
    const direct = String(context.sessionId || "").match(UUID_RE)?.[0]?.toLowerCase();
    if (direct) {
      if (!this.fileById.has(direct)) this.scanFiles(true);
      const entry = this.entries.find((item) => item.id.toLowerCase() === direct);
      return this.fileById.has(direct) ? { id: direct, filePath: this.fileById.get(direct), title: entry?.title || context.title || "" } : null;
    }

    const hints = [context.selectedText, context.title, context.heading, ...(Array.isArray(context.candidates) ? context.candidates : [])]
      .map(normalizeTitle)
      .filter((value) => value && value !== "codex" && value !== "chatgpt");
    let entry = this.entries.find((candidate) => hints.some((hint) => candidate.normalizedTitle === hint));
    if (!entry) {
      entry = this.entries.find((candidate) => hints.some((hint) =>
        hint.includes(candidate.normalizedTitle) || candidate.normalizedTitle.includes(hint),
      ));
    }
    if (!entry) return null;
    const id = entry.id.toLowerCase();
    if (!this.fileById.has(id)) this.scanFiles(true);
    return this.fileById.has(id) ? { id, filePath: this.fileById.get(id), title: entry.title } : null;
  }
}

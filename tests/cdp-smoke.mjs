const port = process.env.CODEX_TRAJECTORY_TEST_PORT || "9333";
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && /panel-harness\.html/.test(item.url || "") && item.webSocketDebuggerUrl)
  || targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error("No CDP page target");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error("CDP smoke timeout")), 5000);
    const receive = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result?.result?.value);
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
}
const result = await evaluate(`(() => {
  const root = document.querySelector('#codex-trajectory-panel-host')?.shadowRoot;
  if (root?.querySelector('.turns-icon')?.textContent === '⊞') root.querySelector('[data-action="turns"]')?.click();
  if (root?.querySelector('.calls-icon')?.textContent === '⊞') root.querySelector('[data-action="calls"]')?.click();
  const failed = root?.querySelector('.record-row.error');
  failed?.click();
  const toolTabs = [...(root?.querySelectorAll('.detail-tab') || [])].map((node) => node.textContent);
  const toolStatus = root?.querySelector('.status')?.textContent;
  const assistant = root?.querySelector('.record-row .badge.assistant')?.closest('.record-row');
  assistant?.click();
  const assistantTabs = [...(root?.querySelectorAll('.detail-tab') || [])].map((node) => node.textContent);
  const assistantSummary = root?.querySelector('.inspector-body')?.textContent;
  const durationButton = root?.querySelector('[data-action="duration"]');
  const durationBefore = durationButton?.getAttribute('aria-pressed');
  durationButton?.click();
  return {
    version: window.__codexTrajectoryPanel?.version,
    context: window.__codexTrajectoryPanel?.getContext?.(),
    status: root?.querySelector('.dot')?.className,
    failedEvents: root?.querySelectorAll('.record-row.error')?.length,
    inspectorVisible: !root?.querySelector('.inspector')?.classList.contains('hidden'),
    toolTabs,
    toolStatus,
    assistantTabs,
    assistantSummary,
    controls: [...(root?.querySelectorAll('.trace-control') || [])].map((node) => node.textContent.trim()),
    durationActive: durationButton?.getAttribute('aria-pressed'),
    durationBefore,
    statCards: root?.querySelectorAll('.stat')?.length,
    hostParentIsTask: document.querySelector('#codex-trajectory-panel-host')?.parentElement?.matches?.('[data-app-shell-focus-area="main"]'),
    hostPosition: document.querySelector('#codex-trajectory-panel-host')?.style.position,
    switcherPosition: getComputedStyle(root?.querySelector('.switcher')).position,
    panelPosition: getComputedStyle(root?.querySelector('.panel')).position,
    panelTop: getComputedStyle(root?.querySelector('.panel')).top,
    switcherTransform: getComputedStyle(root?.querySelector('.switcher')).transform,
    readyDotDisplay: getComputedStyle(root?.querySelector('.dot')).display,
  };
})()`);
socket.close();
console.log(JSON.stringify(result, null, 2));
if (result?.version !== "0.6.6") throw new Error("Trajectory panel was not injected");
if (result?.context?.sessionId !== "11111111-1111-4111-8111-111111111111") throw new Error("Current task was not identified");
if (!result?.failedEvents || !result?.inspectorVisible) throw new Error("Failed tool inspector did not open");
for (const tab of ["Summary", "Payload", "Result", "Schema", "Timing"]) {
  if (!result.toolTabs.includes(tab)) throw new Error(`Missing tool inspector tab: ${tab}`);
}
if (result.toolTabs.includes("Raw") || result.toolTabs.includes("Source")) throw new Error("Tool tabs do not match DSH");
for (const tab of ["Summary", "Preview", "Raw"]) if (!result.assistantTabs.includes(tab)) throw new Error(`Missing assistant tab: ${tab}`);
if (!/Request #1/.test(result.assistantSummary) || !/Reasoning/.test(result.assistantSummary) || !/TTFT/.test(result.assistantSummary)) throw new Error("Assistant request details are incomplete");
if (result?.toolStatus !== "Failed") throw new Error("Failed tool state was not rendered");
if (result?.durationActive === result?.durationBefore) throw new Error("Duration mode did not toggle");
if (result?.statCards !== 0) throw new Error("Old summary cards are still present");
if (!result?.hostParentIsTask) throw new Error("Trajectory panel was not mounted inside the task area");
if (result?.hostPosition !== "absolute" || result?.switcherPosition !== "absolute" || result?.panelPosition !== "absolute" || Number.parseFloat(result?.panelTop) < 46) throw new Error("Trajectory panel is still viewport-fixed or overlaps the task header");
if (result?.switcherTransform !== "none" || result?.readyDotDisplay !== "none") throw new Error("Trajectory tabs are still using the floating-pill treatment");

import fs from "node:fs";

const port = process.env.CODEX_TRAJECTORY_TEST_PORT || "9333";
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url === "app://-/index.html" && item.webSocketDebuggerUrl);
if (!target) throw new Error("No live Codex page target");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error("Live layout inspection timed out")), 5000);
    const receive = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true });
  return result?.result?.value;
}

const forcedPanelWidth = Number(process.env.CODEX_TRAJECTORY_PANEL_WIDTH || 0);
let originalPanelStyle = null;
if (forcedPanelWidth > 0) {
  originalPanelStyle = await evaluate(`(() => {
    const side = document.querySelector('aside[data-app-shell-focus-area="right-panel"]');
    if (!side) return null;
    const style = side.getAttribute('style');
    side.style.width = ${JSON.stringify(`${forcedPanelWidth}px`)};
    return style;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 220));
}

const captureTrace = process.argv.includes("--trace");
let originalCaptureView = null;
if (captureTrace) {
  originalCaptureView = await evaluate(`(() => {
    const root = document.querySelector('#codex-trajectory-panel-host')?.shadowRoot;
    const view = root?.querySelector('.view-tab.active')?.dataset.view || 'chat';
    root?.querySelector('[data-view="trace"]')?.click();
    return view;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 120));
}

const result = await evaluate(`(() => {
  const rect = (node) => {
    const value = node?.getBoundingClientRect();
    return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } : null;
  };
  const host = document.querySelector('#codex-trajectory-panel-host');
  const root = host?.shadowRoot;
  const mount = document.querySelector('[data-app-shell-focus-area="main"]');
  const conversation = document.querySelector('[data-thread-find-target="conversation"]');
  const timeline = document.querySelector('[data-app-action-timeline-scroll]');
  const candidates = [...document.querySelectorAll('aside,[data-app-shell-focus-area],[data-testid*="panel"],[aria-label*="browser" i]')]
    .filter((node) => node !== host && rect(node)?.width > 0)
    .map((node) => ({ tag: node.tagName, id: node.id, className: String(node.className || '').slice(0, 200), style: node.getAttribute('style'), focusArea: node.getAttribute('data-app-shell-focus-area'), testId: node.getAttribute('data-testid'), ariaLabel: node.getAttribute('aria-label'), rect: rect(node) }));
  const headerItems = [...document.querySelectorAll('button,a,[role="button"]')]
    .filter((node) => !host?.contains(node))
    .map((node) => ({ text: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 80), ariaLabel: node.getAttribute('aria-label'), rect: rect(node) }))
    .filter((item) => item.rect?.width > 0 && item.rect.top < (rect(timeline)?.top || 120));
  const topControls = [...document.querySelectorAll('button,a,[role="button"]')]
    .filter((node) => {
      if (!mount || node.getRootNode() !== document) return false;
      const item = rect(node);
      const bounds = rect(mount);
      const center = item ? item.left + item.width / 2 : 0;
      return item?.width > 0 && center >= bounds.left && center <= bounds.right && item.top >= bounds.top - 1 && item.top < bounds.top + 50;
    })
    .map((node) => ({
      text: (node.textContent || '').trim().slice(0, 100),
      ariaLabel: node.getAttribute('aria-label'),
      className: String(node.className || '').slice(0, 180),
      rect: rect(node),
      parent: { tag: node.parentElement?.tagName, className: String(node.parentElement?.className || '').slice(0, 180), rect: rect(node.parentElement) },
      grandparent: { tag: node.parentElement?.parentElement?.tagName, className: String(node.parentElement?.parentElement?.className || '').slice(0, 180), rect: rect(node.parentElement?.parentElement) },
    }));
  return {
    innerWidth: window.innerWidth,
    version: window.__codexTrajectoryPanel?.version,
    mount: rect(mount),
    host: rect(host),
    mountChildren: [...(mount?.children || [])].map((node) => ({
      tag: node.tagName,
      id: node.id,
      className: String(node.className || '').slice(0, 240),
      style: node.getAttribute('style'),
      rect: rect(node),
    })),
    conversation: rect(conversation),
    timeline: rect(timeline),
    switcher: { className: root?.querySelector('.switcher')?.className, rect: rect(root?.querySelector('.switcher')), transform: root?.querySelector('.switcher')?.style.transform },
    stats: { hidden: root?.querySelector('.stats-dock')?.hidden, className: root?.querySelector('.stats-dock')?.className, rect: rect(root?.querySelector('.stats-dock')), right: root?.querySelector('.stats-dock')?.style.right },
    candidates,
    headerItems,
    topControls,
  };
})()`);

let smoke = null;
const smokeErrors = [];
if (process.argv.includes("--smoke")) {
  smoke = await evaluate(`(() => {
    const root = document.querySelector('#codex-trajectory-panel-host')?.shadowRoot;
    const originalView = root?.querySelector('.view-tab.active')?.dataset.view || 'chat';
    root?.querySelector('[data-view="trace"]')?.click();
    const traceVisible = root?.querySelector('.panel')?.classList.contains('show') === true;
    root?.querySelector('[data-view="chat"]')?.click();
    const stats = root?.querySelector('.stats-dock');
    const tokenButton = root?.querySelector('.token-pill');
    const tokenRect = tokenButton?.getBoundingClientRect();
    const metrics = Object.fromEntries([...root.querySelectorAll('[data-metric]')].map((node) => [node.dataset.metric, node.textContent]));
    return {
      originalView,
      traceVisible,
      statsVisible: !stats?.hidden && getComputedStyle(stats).display !== 'none',
      tokenCenter: tokenRect ? { x: tokenRect.left + tokenRect.width / 2, y: tokenRect.top + tokenRect.height / 2 } : null,
      metrics,
    };
  })()`);
  if (smoke?.tokenCenter) {
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: smoke.tokenCenter.x, y: smoke.tokenCenter.y });
    await new Promise((resolve) => setTimeout(resolve, 320));
  }
  const popoverState = await evaluate(`(() => {
    const host = document.querySelector('#codex-trajectory-panel-host');
    const root = host?.shadowRoot;
    const popover = document.querySelector('#codex-trajectory-panel-host')?.shadowRoot?.querySelector('.token-popover');
    const x = ${JSON.stringify(smoke?.tokenCenter?.x || 0)};
    const y = ${JSON.stringify(smoke?.tokenCenter?.y || 0)};
    const pageHit = document.elementFromPoint(x, y);
    const shadowHit = root?.elementFromPoint?.(x, y);
    return {
      visible: Boolean(popover && getComputedStyle(popover).visibility === 'visible' && Number(getComputedStyle(popover).opacity) > .9),
      pageHit: pageHit ? { tag: pageHit.tagName, id: pageHit.id, className: String(pageHit.className || '') } : null,
      shadowHit: shadowHit ? { tag: shadowHit.tagName, className: String(shadowHit.className || ''), ariaLabel: shadowHit.getAttribute?.('aria-label') } : null,
    };
  })()`);
  smoke.popoverVisible = popoverState?.visible;
  smoke.hitTest = popoverState;
  console.log(JSON.stringify({ smoke }, null, 2));
  if (!smoke?.traceVisible) smokeErrors.push("Live trajectory view did not open");
  if (!smoke?.statsVisible || !smoke?.popoverVisible) smokeErrors.push("Live performance statistics did not open");
  for (const name of ["ttft", "tps", "cache-hit", "uncached-input", "cached-input", "output"]) {
    if (!smoke.metrics?.[name]) smokeErrors.push(`Missing live metric: ${name}`);
  }
}

const screenshotPath = process.env.CODEX_TRAJECTORY_SCREENSHOT;
if (screenshotPath) {
  const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

if (smoke) {
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: result.mount.left + result.mount.width / 2, y: result.timeline.top + 80 });
  await evaluate(`document.querySelector('#codex-trajectory-panel-host')?.shadowRoot?.querySelector('[data-view="' + ${JSON.stringify(smoke.originalView)} + '"]')?.click()`);
}

if (captureTrace) {
  await evaluate(`document.querySelector('#codex-trajectory-panel-host')?.shadowRoot?.querySelector('[data-view="' + ${JSON.stringify(originalCaptureView)} + '"]')?.click()`);
}

if (forcedPanelWidth > 0) {
  await evaluate(`(() => {
    const side = document.querySelector('aside[data-app-shell-focus-area="right-panel"]');
    if (!side) return;
    const style = ${JSON.stringify(originalPanelStyle)};
    if (style == null) side.removeAttribute('style');
    else side.setAttribute('style', style);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 220));
}

socket.close();
console.log(JSON.stringify(result, null, 2));
if (smokeErrors.length) throw new Error(smokeErrors.join("; "));

// content.js (final integrated)
// Features:
// - Auto-detects & stores your nickname from "Create Your Profile" modal (Nickname input)
// - Ignores chat history on initial load (warm-up) so only messages after you join trigger notifications
// - Only notifies when "Private" tab is ON (v1 policy)
// - Excludes your own messages using detected nickname
// - Dedupe (WeakSet + signature LRU) + cooldown + safe sendMessage

// ======================================================
// 0) My name (auto) from profile modal
// ======================================================
let MY_NAME = null;

async function loadMyName() {
  const res = await chrome.storage.local.get({ myNameAuto: null });
  MY_NAME = res.myNameAuto;
  return MY_NAME;
}

async function saveMyName(name) {
  const n = (name ?? "").toString().trim();
  if (!n) return;
  if (MY_NAME === n) return;
  MY_NAME = n;
  await chrome.storage.local.set({ myNameAuto: n });
  console.log("[ZEP Notifier] saved my name:", n);
}

// Label-text based input finder (minimize hardcoding)
function findInputByLabelText(root, labelText) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  const labelEl = nodes.find((el) => {
    const t = (el.textContent || "").trim();
    return t === labelText || t.includes(labelText);
  });
  if (!labelEl) return null;

  // 1) nearby input
  let input =
    labelEl.querySelector?.("input") ||
    labelEl.parentElement?.querySelector?.("input") ||
    labelEl.closest?.("div")?.querySelector?.("input");

  if (input) return input;

  // 2) siblings after label
  let cur = labelEl;
  for (let i = 0; i < 10; i++) {
    cur = cur.nextElementSibling;
    if (!cur) break;
    const cand = cur.querySelector?.("input") || (cur.tagName === "INPUT" ? cur : null);
    if (cand) return cand;
  }

  return null;
}

function bootProfileNameHook() {
  loadMyName(); // preload existing if any

  let hooked = false;

  const tryHook = () => {
    if (hooked) return;

    // Find modal/container by headline text
    const modalRoot =
      Array.from(document.querySelectorAll("div, section, main"))
        .find((el) => (el.textContent || "").includes("Create Your Profile")) || null;

    if (!modalRoot) return;

    const nicknameInput =
      findInputByLabelText(modalRoot, "Nickname") ||
      findInputByLabelText(modalRoot, "닉네임");

    if (!nicknameInput) return;

    const commit = () => saveMyName(nicknameInput.value);

    nicknameInput.addEventListener("input", commit, { passive: true });
    nicknameInput.addEventListener("change", commit, { passive: true });
    nicknameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });

    const enterBtn =
      Array.from(modalRoot.querySelectorAll("button"))
        .find((b) => ((b.textContent || "").trim().toLowerCase() === "enter"));

    if (enterBtn) enterBtn.addEventListener("click", commit, { passive: true });

    hooked = true;
    console.log("[ZEP Notifier] hooked Nickname input");
  };

  // 1) try immediately
  tryHook();

  // 2) keep trying until hooked (modal may appear later)
  const obs = new MutationObserver(() => {
    if (!hooked) tryHook();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

bootProfileNameHook();

// ======================================================
// 1) Settings (notification policy, cooldown, debug)
// ======================================================
const DEFAULTS = {
  onlyWhenPrivateOn: true, // v1 policy
  cooldownMs: 1500,        // prevent notification spam
  debug: false             // optional logs
};

let SETTINGS = { ...DEFAULTS };

function log(...args) {
  if (SETTINGS.debug) console.log("[ZEP Notifier]", ...args);
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (res) => {
    SETTINGS = { ...DEFAULTS, ...res };
    log("settings loaded", SETTINGS);
  });
}

loadSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let changed = false;
  for (const k of Object.keys(DEFAULTS)) {
    if (changes[k]) {
      SETTINGS[k] = changes[k].newValue;
      changed = true;
    }
  }
  if (changed) log("settings updated", SETTINGS);
});

// ======================================================
// 2) DOM Selectors
// ======================================================
const BUBBLE_SELECTOR = '[data-sentry-element="BubbleWrapper"]';
const SENDER_SELECTOR = '[data-sentry-component="SenderName"]';
const CONTENT_SELECTOR = '[data-sentry-element="MessageContent"]';

// Private tab ON check
function isPrivateTabOn() {
  const on = document.querySelector(
    'button[role="radio"][data-state="on"] span[data-sentry-component="ChatTabItemContent"]'
  );
  return (on?.textContent || "").trim() === "Private";
}

// ======================================================
// 3) Ignore history on initial load (Warm-up)
// ======================================================
// Why: On login, ZEP often renders past chat history as "new DOM nodes".
// We want notifications only from the moment you joined (after warm-up).
let NOTIFY_READY = false;
const WARMUP_MS = 2500; // adjust if needed (slow network: 4000)

setTimeout(() => {
  NOTIFY_READY = true;
  console.log("[ZEP Notifier] notify ready ✅");
}, WARMUP_MS);

// ======================================================
// 4) Dedupe + Cooldown
// ======================================================
const seenNodes = new WeakSet();
let lastNotifyAt = 0;

// signature LRU
const recentSigs = new Set();
const MAX_SIGS = 200;

function addSig(sig) {
  recentSigs.add(sig);
  if (recentSigs.size > MAX_SIGS) {
    const first = recentSigs.values().next().value;
    recentSigs.delete(first);
  }
}

function canNotifyNow() {
  const cd = Number(SETTINGS.cooldownMs) || 0;
  if (cd <= 0) return true;
  const now = Date.now();
  if (now - lastNotifyAt >= cd) {
    lastNotifyAt = now;
    return true;
  }
  return false;
}

// ======================================================
// 5) Extract message from bubble
// ======================================================
function extractMessage(bubbleEl) {
  const sender = bubbleEl.querySelector(SENDER_SELECTOR)?.innerText?.trim() || "";
  const contentEl = bubbleEl.querySelector(CONTENT_SELECTOR);

  const body =
    contentEl?.querySelector("p")?.innerText?.trim() ||
    contentEl?.innerText?.trim() ||
    "";

  if (!sender || !body) return null;
  return { sender, body };
}

// ======================================================
// 6) Notify background safely
// ======================================================
function notifyBackground(title, body) {
  const safeTitle = (title ?? "").toString().trim() || "ZEP";
  const safeBody = (body ?? "").toString().trim() || "새 메시지가 도착했어요";

  try {
    chrome.runtime.sendMessage({
      type: "ZEP_NOTIFY",
      payload: { title: safeTitle, body: safeBody }
    });
  } catch (e) {
    // common during extension reload: "Extension context invalidated"
    console.warn("[ZEP Notifier] sendMessage failed:", e);
  }
}

// ======================================================
// 7) Main handler
// ======================================================
function handleBubble(bubbleEl) {
  if (!(bubbleEl instanceof HTMLElement)) return;
  if (seenNodes.has(bubbleEl)) return;

  // v1 policy: Private tab only
  if (SETTINGS.onlyWhenPrivateOn && !isPrivateTabOn()) return;

  const msg = extractMessage(bubbleEl);
  if (!msg) return;

  // Warm-up: treat as history loading (do not notify)
  if (!NOTIFY_READY) {
    seenNodes.add(bubbleEl);
    return;
  }

  // Exclude my own messages
  if (MY_NAME && msg.sender === MY_NAME) {
    seenNodes.add(bubbleEl);
    return;
  }

  // Dedupe by signature
  const sig = `${msg.sender}::${msg.body}`;
  if (recentSigs.has(sig)) {
    seenNodes.add(bubbleEl);
    return;
  }

  // Cooldown
  if (!canNotifyNow()) {
    seenNodes.add(bubbleEl);
    return;
  }

  // Mark seen
  seenNodes.add(bubbleEl);
  addSig(sig);

  // ✅ Title: sender / Body: message
  notifyBackground(msg.sender, msg.body);
}

// ======================================================
// 8) Prime existing bubbles (avoid notifying already-rendered nodes)
// ======================================================
function primeExistingBubbles() {
  const bubbles = document.querySelectorAll(BUBBLE_SELECTOR);
  bubbles.forEach((b) => seenNodes.add(b));
  console.log(`[ZEP Notifier] primed existing bubbles: ${bubbles.length}`);
}

// ======================================================
// 9) Observe DOM mutations
// ======================================================
function bootObserver() {
  const root = document.body;
  if (!root) return;

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.matches?.(BUBBLE_SELECTOR)) {
          handleBubble(node);
          continue;
        }

        const bubbles = node.querySelectorAll?.(BUBBLE_SELECTOR);
        if (bubbles?.length) bubbles.forEach(handleBubble);
      }
    }
  });

  // Prime what already exists before we start listening
  primeExistingBubbles();

  observer.observe(root, { childList: true, subtree: true });
  console.log("[ZEP Notifier] observer running");
}

bootObserver();
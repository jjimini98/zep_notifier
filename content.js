// ======================================================
// ZEP Private Chat Notifier - FINAL STABLE VERSION
// ======================================================

// ------------------------------------------------------
// 0. Utils
// ------------------------------------------------------
function normalizeName(name) {
  return (name ?? "")
    .toString()
    .normalize("NFKC")
    .replace(/\u200b/g, "")
    .replace(/\s/g, "")
    .trim();
}

// ------------------------------------------------------
// 1. My Name (auto detect from profile modal)
// ------------------------------------------------------
let MY_NAME = null;

async function loadMyName() {
  const res = await chrome.storage.local.get({ myNameAuto: null });
  MY_NAME = res.myNameAuto ? normalizeName(res.myNameAuto) : null;
}

async function saveMyName(name) {
  const n = normalizeName(name);
  if (!n) return;
  if (MY_NAME === n) return;

  MY_NAME = n;
  await chrome.storage.local.set({ myNameAuto: n });

  console.log("[ZEP] My name saved:", n);
}

function bootProfileNameHook() {
  loadMyName();

  let hooked = false;

  const tryHook = () => {
    if (hooked) return;

    // ✅ 1차: placeholder 기반 (가장 안정적)
    let input =
      document.querySelector('input[placeholder="Enter your nickname"]');

    // ✅ 2차 fallback (UI 변경 대비)
    if (!input) {
      input = document.querySelector(
        'input[data-sentry-element="Input"]'
      );
    }

    if (!input) return;

    const commit = () => saveMyName(input.value);

    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") commit();
    });

    // Enter 버튼 클릭
    const enterBtn = [...document.querySelectorAll("button")]
      .find(b => (b.textContent || "").trim().toLowerCase() === "enter");

    if (enterBtn) {
      enterBtn.addEventListener("click", commit);
    }

    hooked = true;
    console.log("[ZEP] Nickname hook attached ✅");
  };

  tryHook();

  const obs = new MutationObserver(() => {
    if (!hooked) tryHook();
  });

  obs.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

bootProfileNameHook();

// ------------------------------------------------------
// 2. Settings
// ------------------------------------------------------
const SETTINGS = {
  cooldownMs: 1500,
  onlyWhenPrivateOn: true
};

// ------------------------------------------------------
// 3. Selectors
// ------------------------------------------------------
const BUBBLE_SELECTOR = '[data-sentry-element="BubbleWrapper"]';
const SENDER_SELECTOR = '[data-sentry-component="SenderName"]';
const CONTENT_SELECTOR = '[data-sentry-element="MessageContent"]';

// ------------------------------------------------------
// 4. Private tab check
// ------------------------------------------------------
function isPrivateTabOn() {
  const el = document.querySelector(
    'button[role="radio"][data-state="on"] span[data-sentry-component="ChatTabItemContent"]'
  );
  return (el?.textContent || "").trim() === "Private";
}

// ------------------------------------------------------
// 5. Warm-up (ignore history messages)
// ------------------------------------------------------
let NOTIFY_READY = false;

setTimeout(() => {
  NOTIFY_READY = true;
  console.log("[ZEP] Notification ready");
}, 2500);

// ------------------------------------------------------
// 6. Dedup + cooldown
// ------------------------------------------------------
const seenNodes = new WeakSet();
const recentSigs = new Set();
let lastNotify = 0;

function canNotify() {
  const now = Date.now();
  if (now - lastNotify < SETTINGS.cooldownMs) return false;
  lastNotify = now;
  return true;
}

function addSig(sig) {
  recentSigs.add(sig);
  if (recentSigs.size > 200) {
    const first = recentSigs.values().next().value;
    recentSigs.delete(first);
  }
}

// ------------------------------------------------------
// 7. Extract message
// ------------------------------------------------------
function extractMessage(bubble) {
  const senderRaw =
    bubble.querySelector(SENDER_SELECTOR)?.innerText ?? "";

  const sender = normalizeName(senderRaw);

  const contentEl = bubble.querySelector(CONTENT_SELECTOR);

  const body =
    contentEl?.querySelector("p")?.innerText?.trim() ||
    contentEl?.innerText?.trim() ||
    "";

  if (!sender || !body) return null;

  return { sender, body };
}

// ------------------------------------------------------
// 8. Send notification
// ------------------------------------------------------
function notify(title, body) {
  try {
    chrome.runtime.sendMessage({
      type: "ZEP_NOTIFY",
      payload: {
        title: title || "ZEP",
        body: body || "새 메시지"
      }
    });
  } catch (e) {
    console.warn("[ZEP] sendMessage failed", e);
  }
}

// ------------------------------------------------------
// 9. Main handler
// ------------------------------------------------------
function handleBubble(bubble) {
  if (!(bubble instanceof HTMLElement)) return;
  if (seenNodes.has(bubble)) return;

  if (SETTINGS.onlyWhenPrivateOn && !isPrivateTabOn()) return;

  const msg = extractMessage(bubble);
  if (!msg) return;

  // 로그인 직후 기록 무시
  if (!NOTIFY_READY) {
    seenNodes.add(bubble);
    return;
  }

  // ✅ 내 메시지 제외 (핵심)
  if (MY_NAME && msg.sender === MY_NAME) {
    seenNodes.add(bubble);
    return;
  }

  const sig = msg.sender + "::" + msg.body;

  if (recentSigs.has(sig)) {
    seenNodes.add(bubble);
    return;
  }

  if (!canNotify()) {
    seenNodes.add(bubble);
    return;
  }

  seenNodes.add(bubble);
  addSig(sig);

  notify(msg.sender, msg.body);
}

// ------------------------------------------------------
// 10. Prime existing bubbles
// ------------------------------------------------------
function primeExisting() {
  document.querySelectorAll(BUBBLE_SELECTOR)
    .forEach(el => seenNodes.add(el));
}

// ------------------------------------------------------
// 11. Observer
// ------------------------------------------------------
function bootObserver() {
  primeExisting();

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.matches?.(BUBBLE_SELECTOR)) {
          handleBubble(node);
          continue;
        }

        node.querySelectorAll?.(BUBBLE_SELECTOR)
          .forEach(handleBubble);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log("[ZEP] Observer running");
}

bootObserver();
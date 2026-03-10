// 알림 생성 (content.js -> sendMessage로 호출)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ZEP_NOTIFY") return;

  const payload = msg.payload || {};
  const title = (payload.title ?? "").toString().trim() || "ZEP";
  const body = (payload.body ?? "").toString().trim() || "새 메시지가 도착했어요";

  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title,
    message: body
  });
});


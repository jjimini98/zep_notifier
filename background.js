// background.js (MV3 service worker)

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

// 알림 클릭 시: ZEP 탭 앞으로 가져오기
chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.query({ url: "https://zep.us/*" }, (tabs) => {
    if (!tabs?.length) return;

    // 가장 첫 번째 탭을 선택 (필요하면 "가장 최근" 로직으로 개선 가능)
    const t = tabs[0];

    chrome.windows.update(t.windowId, { focused: true }, () => {
      chrome.tabs.update(t.id, { active: true });
    });
  });
});
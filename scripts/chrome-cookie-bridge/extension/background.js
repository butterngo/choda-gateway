// MV3 service worker. Notices when the ichiba session cookies change in Chrome
// and pushes their values to the native messaging host, which writes the
// gateway's cookie-jar file. The worker is ephemeral: Chrome runs this file
// once to register the listeners below, then wakes it only when an event fires.

const TARGET_DOMAIN = "test-api.ichiba.net";
const TARGET_URL = "https://test-api.ichiba.net/";
const WANT = ["SERVERID", "__BFF"]; // order preserved in the written file
const HOST_NAME = "com.ichiba.cookie_host"; // must match the native host manifest

// Two cookies usually change together around login; debounce so we send once.
let debounceTimer = null;
function scheduleSync() {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(syncCookies, 600);
}

async function syncCookies() {
	debounceTimer = null;
	const cookies = [];
	for (const name of WANT) {
		// chrome.cookies.get returns HttpOnly values too (extension privilege).
		const c = await chrome.cookies.get({ url: TARGET_URL, name });
		if (c) cookies.push({ name: c.name, value: c.value });
	}
	if (!cookies.some((c) => c.name === "__BFF")) {
		console.log("[ichiba-bridge] no __BFF cookie yet — skipping write");
		return;
	}
	chrome.runtime.sendNativeMessage(HOST_NAME, { cookies }, (resp) => {
		if (chrome.runtime.lastError) {
			console.error(
				"[ichiba-bridge] native host error:",
				chrome.runtime.lastError.message,
			);
			return;
		}
		console.log("[ichiba-bridge] cookie file updated:", resp);
	});
}

// Wake on every set/update; ignore deletions and unrelated cookies.
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
	if (!WANT.includes(cookie.name)) return;
	if (!cookie.domain.endsWith(TARGET_DOMAIN)) return;
	if (removed) return;
	scheduleSync();
});

// onChanged is future-only — grab whatever is already in the jar at startup/install.
chrome.runtime.onStartup.addListener(scheduleSync);
chrome.runtime.onInstalled.addListener(scheduleSync);

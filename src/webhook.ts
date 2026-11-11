import type { requestUrl } from "obsidian";

export async function notifyWebhook(request: typeof requestUrl, url: string, payload: unknown, timeoutMs = 5000): Promise<void> {
  const endpoint = new URL(url);
  if (!/^https?:$/.test(endpoint.protocol)) throw new Error("웹훅은 HTTP(S) 주소여야 합니다.");
  let timer = 0;
  try {
    // Timeout stops waiting; requestUrl cannot abort and may still complete later.
    const response = await Promise.race([
      request({ url: endpoint.href, method: "POST", contentType: "application/json", body: JSON.stringify(payload), throw: false }),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("Webhook timeout")), timeoutMs); }),
    ]);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  } finally { window.clearTimeout(timer); }
}

import type { App } from "obsidian";

/** Host advertisement published by an agent host plugin instance (host-capabilities-v1 section 6). */
export const HOST_ADVERTISEMENT = Symbol.for("dev.agentinterop.host");
export const HOST_CAPABILITIES_CONTRACT = "host-capabilities-v1";

/**
 * True when some plugin instance advertises the host-capabilities-v1 contract.
 * Only own data properties count; a getter is never run (same detection as Web Hands).
 * Evaluate at the moment of use: the host can load, update or unload after this plugin.
 */
export function hostAdvertisesCapabilities(app: App): boolean {
  const plugins = (app as unknown as { plugins?: { plugins?: unknown } })?.plugins?.plugins;
  if (!plugins || typeof plugins !== "object") return false;
  for (const instance of Object.values(plugins as Record<string, unknown>)) {
    if (!instance || typeof instance !== "object") continue;
    const descriptor = Object.getOwnPropertyDescriptor(instance, HOST_ADVERTISEMENT);
    if (!descriptor || !("value" in descriptor)) continue;
    const advertisement = descriptor.value as { protocol?: unknown; contracts?: unknown } | null;
    if (advertisement?.protocol === "agentinterop" && Array.isArray(advertisement.contracts) && advertisement.contracts.includes(HOST_CAPABILITIES_CONTRACT)) return true;
  }
  return false;
}

/**
 * Defines `indexTextVersion` on the plugin api as an accessor, evaluated on every read.
 * A host that advertises host-capabilities-v1 uses the agentinterop `extractText` member (with approval)
 * instead of the direct `api.indexText` call, so v1 reads as absent for it; a host without the
 * advertisement keeps reading `1`. Only this field is gated.
 */
export function gateIndexTextVersion<T extends object>(app: App, api: T): T & { readonly indexTextVersion: 1 | undefined } {
  Object.defineProperty(api, "indexTextVersion", { enumerable: true, configurable: true, get: (): 1 | undefined => (hostAdvertisesCapabilities(app) ? undefined : 1) });
  return api as T & { readonly indexTextVersion: 1 | undefined };
}

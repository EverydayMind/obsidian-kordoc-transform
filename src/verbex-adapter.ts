import type { App } from "obsidian";
import {
  KordocProviderError,
  VERBEX_CHAT_HOST_PROTOCOL_VERSION,
  VERBEX_PROVIDER_HOST_PROTOCOL_VERSION,
  type KordocProvider,
  type VerbexChatApi,
  type VerbexProviderRegistration,
  type VerbexProviderRegistry,
} from "./verbex-contract";

type VerbexPluginLike = {
  api?: {
    providerRegistry?: unknown;
    chat?: unknown;
  };
};

/**
 * The only place where the importer relies on Obsidian's de-facto
 * app.plugins.plugins convention. Keep this boundary small so a future
 * public Obsidian API can replace it without changing the provider.
 */
export function resolveVerbexProviderRegistry(app: App): VerbexProviderRegistry | null {
  const pluginContainer = (app as App & {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins;
  const verbex = pluginContainer?.plugins?.["verbex"] as VerbexPluginLike | undefined;
  const candidate = verbex?.api?.providerRegistry as Partial<VerbexProviderRegistry> | undefined;
  if (!candidate) return null;
  if (candidate.protocolVersion !== VERBEX_PROVIDER_HOST_PROTOCOL_VERSION) {
    throw new KordocProviderError(
      "PROTOCOL_MISMATCH",
      `Verbex provider registry protocol mismatch: ${String(candidate.protocolVersion)}`,
    );
  }
  if (typeof candidate.generation !== "string" || typeof candidate.registerProvider !== "function") {
    return null;
  }
  return candidate as VerbexProviderRegistry;
}

/**
 * Resolve the small public chat bridge exposed by Verbex. KORDOC never reaches
 * into React or invokes the provider directly; the message goes through
 * Verbex's normal chat submission and host approval flow.
 */
export function resolveVerbexChatApi(app: App): VerbexChatApi | null {
  const pluginContainer = (app as App & {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins;
  const verbex = pluginContainer?.plugins?.["verbex"] as VerbexPluginLike | undefined;
  const candidate = verbex?.api?.chat as Partial<VerbexChatApi> | undefined;
  if (!candidate) return null;
  if (candidate.protocolVersion !== VERBEX_CHAT_HOST_PROTOCOL_VERSION) {
    throw new KordocProviderError(
      "PROTOCOL_MISMATCH",
      `Verbex chat protocol mismatch: ${String(candidate.protocolVersion)}`,
    );
  }
  if (typeof candidate.sendMessage !== "function") return null;
  return candidate as VerbexChatApi;
}

export interface KordocVerbexRegistration {
  generation: string;
  registration: VerbexProviderRegistration;
}

/**
 * Owns the importer side of the Verbex registry handshake.
 *
 * Keeping this state machine outside of the plugin class makes the two
 * discovery paths (immediate lookup and registry-ready event) testable without
 * importing the whole Obsidian view/command surface.  A registration is valid
 * only for the generation that created it; a missing registry or a failed
 * protocol check always tears down the previous registration first.
 */
export class KordocVerbexRegistrationManager {
  private current: KordocVerbexRegistration | undefined;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly provider: KordocProvider,
  ) {}

  get generation(): string | undefined {
    return this.current?.generation;
  }

  get isRegistered(): boolean {
    return this.current !== undefined;
  }

  sync(): void {
    if (this.disposed) return;
    try {
      const registry = resolveVerbexProviderRegistry(this.app);
      if (!registry) {
        this.disposeCurrent();
        return;
      }
      if (this.current?.generation === registry.generation) return;

      this.disposeCurrent();
      try {
        const registration = registry.registerProvider(this.provider);
        this.current = { generation: registry.generation, registration };
      } catch (error) {
        // A registry that fails during registration must not leave the
        // provider looking registered to the importer.
        this.disposeCurrent();
        throw error;
      }
    } catch (error) {
      // Protocol mismatch and malformed host APIs are integration failures,
      // not document conversion failures. The caller may log them while the
      // standalone importer remains usable.
      this.disposeCurrent();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disposeCurrent();
  }

  private disposeCurrent(): void {
    const current = this.current;
    this.current = undefined;
    current?.registration.dispose();
  }
}

export function registerKordocProviderWithVerbex(
  app: App,
  provider: KordocProvider,
): KordocVerbexRegistration | null {
  const registry = resolveVerbexProviderRegistry(app);
  if (!registry) return null;
  return {
    generation: registry.generation,
    registration: registry.registerProvider(provider),
  };
}

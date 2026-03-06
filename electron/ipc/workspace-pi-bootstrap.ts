import fs from "node:fs";
import path from "node:path";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import {
  getChatonsPiAgentDir,
  getGlobalWorkspaceDir,
} from "./workspace-pi-paths.js";

function getDefaultPiSettings(): Record<string, unknown> {
  return {
    defaultProvider: null,
    defaultModel: null,
    enabledModels: [],
  };
}

function getDefaultPiModels(): Record<string, unknown> {
  return {
    providers: {},
  };
}

function ensurePiAuthJsonExists(agentDir: string): void {
  const authPath = path.join(agentDir, "auth.json");
  if (fs.existsSync(authPath)) {
    return;
  }
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, "{}\n", "utf8");
}

export function cleanupStaleLocks(agentDir: string): void {
  const settingsPath = path.join(agentDir, "settings.json");
  const lockPath = `${settingsPath}.lock`;

  try {
    if (fs.existsSync(lockPath)) {
      const stats = fs.statSync(lockPath);
      const lockAge = Date.now() - stats.mtime.getTime();
      const staleThreshold = 5 * 60 * 1000;

      if (lockAge > staleThreshold) {
        console.log(`Cleaning up stale lock file: ${lockPath}`);
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.warn(
      `Failed to cleanup stale locks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function createSettingsManagerWithRetry(
  cwd: string,
  agentDir: string,
  maxRetries = 3,
): Promise<SettingsManager> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      cleanupStaleLocks(agentDir);
      return SettingsManager.create(cwd, agentDir);
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const delay = 100 * Math.pow(2, attempt - 1);
        console.warn(
          `Attempt ${attempt} failed to create SettingsManager, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

export function syncProviderApiKeysBetweenModelsAndAuth(agentDir: string): void {
  migrateProviderApiKeysToAuthIfNeeded(agentDir);

  const modelsPath = path.join(agentDir, "models.json");
  const authPath = path.join(agentDir, "auth.json");
  if (!fs.existsSync(modelsPath) || !fs.existsSync(authPath)) {
    return;
  }

  type ModelsShape = {
    providers?: Record<string, { apiKey?: unknown }>;
  };
  type AuthShape = Record<string, { type?: unknown; key?: unknown }>;

  let models: ModelsShape | null = null;
  let auth: AuthShape | null = null;
  try {
    models = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as ModelsShape;
    auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthShape;
  } catch {
    return;
  }
  if (!models || typeof models !== "object") return;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return;
  if (!models.providers || typeof models.providers !== "object") return;

  let modelsChanged = false;
  const nextProviders: Record<string, { apiKey?: unknown }> = {
    ...(models.providers as Record<string, { apiKey?: unknown }>),
  };

  for (const [providerName, providerConfig] of Object.entries(nextProviders)) {
    const authEntry = auth[providerName];
    const authKey =
      authEntry &&
      typeof authEntry === "object" &&
      !Array.isArray(authEntry) &&
      authEntry.type === "api_key" &&
      typeof authEntry.key === "string" &&
      authEntry.key.trim().length > 0
        ? authEntry.key.trim()
        : null;
    if (!authKey) {
      continue;
    }

    const modelKey =
      typeof providerConfig?.apiKey === "string"
        ? providerConfig.apiKey.trim()
        : "";
    if (!modelKey || modelKey !== authKey) {
      nextProviders[providerName] = {
        ...(providerConfig ?? {}),
        apiKey: authKey,
      };
      modelsChanged = true;
    }
  }

  if (modelsChanged) {
    const nextModels = {
      ...models,
      providers: nextProviders,
    } as Record<string, unknown>;
    fs.writeFileSync(modelsPath, `${JSON.stringify(nextModels, null, 2)}\n`, "utf8");
  }
}

export function ensurePiAgentBootstrapped(
  atomicWriteJson: (filePath: string, data: Record<string, unknown>) => void,
) {
  const agentDir = getChatonsPiAgentDir();
  const settingsPath = path.join(agentDir, "settings.json");
  const modelsPath = path.join(agentDir, "models.json");
  const sessionsDir = path.join(agentDir, "sessions");
  const worktreesDir = path.join(agentDir, "worktrees", "chaton");
  const binDir = path.join(agentDir, "bin");
  const globalWorkspaceDir = getGlobalWorkspaceDir();

  cleanupStaleLocks(agentDir);

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(globalWorkspaceDir, { recursive: true });

  if (!fs.existsSync(settingsPath)) {
    atomicWriteJson(settingsPath, getDefaultPiSettings());
  }

  if (!fs.existsSync(modelsPath)) {
    atomicWriteJson(modelsPath, getDefaultPiModels());
  }

  ensurePiAuthJsonExists(agentDir);
  syncProviderApiKeysBetweenModelsAndAuth(agentDir);
}

export function migrateProviderApiKeysToAuthIfNeeded(agentDir: string): void {
  const modelsPath = path.join(agentDir, "models.json");
  const authPath = path.join(agentDir, "auth.json");
  ensurePiAuthJsonExists(agentDir);
  if (!fs.existsSync(modelsPath)) {
    return;
  }

  type ModelsShape = {
    providers?: Record<string, { apiKey?: unknown }>;
  };

  let models: ModelsShape | null = null;
  try {
    models = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as ModelsShape;
  } catch {
    return;
  }
  if (!models || typeof models !== "object") {
    return;
  }

  const providers =
    models.providers && typeof models.providers === "object"
      ? models.providers
      : {};
  const apiKeys = Object.entries(providers)
    .map(([provider, cfg]) => {
      const key = cfg?.apiKey;
      return {
        provider,
        key:
          typeof key === "string" && key.trim().length > 0
            ? key.trim()
            : null,
      };
    })
    .filter(
      (entry): entry is { provider: string; key: string } => entry.key !== null,
    );

  if (apiKeys.length === 0) {
    return;
  }

  let auth: Record<string, unknown> = {};
  if (fs.existsSync(authPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        auth = raw as Record<string, unknown>;
      }
    } catch {
      auth = {};
    }
  }

  let changed = false;
  for (const { provider, key } of apiKeys) {
    const existing = auth[provider];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      (existing as { type?: unknown }).type === "api_key" &&
      typeof (existing as { key?: unknown }).key === "string" &&
      (existing as { key: string }).key.trim().length > 0
    ) {
      continue;
    }
    auth[provider] = { type: "api_key", key };
    changed = true;
  }

  if (!changed) {
    return;
  }

  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

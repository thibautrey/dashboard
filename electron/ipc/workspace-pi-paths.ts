import electron from "electron";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const { app } = electron;
const requireFromHere = createRequire(import.meta.url);

export function getChatonsPiAgentDir() {
  return path.join(app.getPath("userData"), ".pi", "agent");
}

export function getGlobalWorkspaceDir() {
  return path.join(app.getPath("userData"), "workspace", "global");
}

export function getPiSettingsPath() {
  return path.join(getChatonsPiAgentDir(), "settings.json");
}

export function getPiModelsPath() {
  return path.join(getChatonsPiAgentDir(), "models.json");
}

export function getPiAgentDir() {
  return getChatonsPiAgentDir();
}

export function getPiBinaryPath() {
  const bundledPiCli = getBundledPiCliPath();
  if (bundledPiCli) {
    return bundledPiCli;
  }
  return null;
}

export function getBundledPiCliPath(): string | null {
  const candidates = new Set<string>();

  try {
    const piEntrypoint = requireFromHere.resolve(
      "@mariozechner/pi-coding-agent",
    );
    const distDir = path.dirname(piEntrypoint);
    candidates.add(path.join(distDir, "cli.js"));
  } catch {
    // Keep probing static candidate paths below.
  }

  const appPath = app.getAppPath();
  const resourcesPath = process.resourcesPath;
  const roots = [
    process.cwd(),
    appPath,
    path.dirname(appPath),
    resourcesPath,
    path.join(resourcesPath, "app.asar.unpacked"),
  ];

  for (const root of roots) {
    candidates.add(
      path.join(
        root,
        "node_modules",
        "@mariozechner",
        "pi-coding-agent",
        "dist",
        "cli.js",
      ),
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

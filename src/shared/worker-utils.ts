import path from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { getWorkerRestartInstructions } from "../utils/error-messages.js";

const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'rpirruccio');

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);

// Cache to avoid repeated settings file reads
let cachedPort: number | null = null;
let cachedHost: string | null = null;

/**
 * Get the worker port number from settings
 * Uses CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

/**
 * Get the worker host address (bind address)
 * Uses CLAUDE_MEM_WORKER_HOST from settings file or default (127.0.0.1)
 * Caches the host value to avoid repeated file reads
 * Note: This is the address the server BINDS to (0.0.0.0 for all interfaces)
 */
export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

/**
 * Get the worker host address for connections (health checks, API calls)
 * If bind host is 0.0.0.0, returns 127.0.0.1 for local connections
 * Otherwise returns the configured host
 */
export function getWorkerConnectHost(): string {
  const bindHost = getWorkerHost();
  // 0.0.0.0 means "all interfaces" for binding, but for connecting we need localhost
  if (bindHost === '0.0.0.0') {
    return '127.0.0.1';
  }
  return bindHost;
}

/**
 * Get the full worker URL
 * Priority: CLAUDE_MEM_WORKER_URL env var > build from host:port
 * Use this for all HTTP connections to worker
 */
export function getWorkerUrl(): string {
  // Check env var first (highest priority for remote mode)
  const envUrl = process.env.CLAUDE_MEM_WORKER_URL;
  if (envUrl && envUrl.trim() !== '') {
    // Remove trailing slash if present
    return envUrl.replace(/\/+$/, '');
  }

  // Build from connect host:port (not bind host)
  return `http://${getWorkerConnectHost()}:${getWorkerPort()}`;
}

/**
 * Check if the worker is configured to run on a remote host
 * Returns true if CLAUDE_MEM_WORKER_HOST is NOT localhost/127.0.0.1
 */
export function isRemoteWorker(): boolean {
  const host = getWorkerHost();
  return host !== '127.0.0.1' && host !== 'localhost';
}

/**
 * Clear the cached port and host values
 * Call this when settings are updated to force re-reading from file
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
}

/**
 * Check if worker is responsive and fully initialized by trying the readiness endpoint
 * Changed from /health to /api/readiness to ensure MCP initialization is complete
 */
async function isWorkerHealthy(): Promise<boolean> {
  const workerUrl = getWorkerUrl();
  
  // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
  const response = await fetch(`${workerUrl}/api/readiness`);
  return response.ok;
}

/**
 * Get the current plugin version from package.json
 */
function getPluginVersion(): string {
  const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string> {
  const workerUrl = getWorkerUrl();
  
  // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
  const response = await fetch(`${workerUrl}/api/version`);
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

/**
 * Check if worker version matches plugin version
 * Note: Auto-restart on version mismatch is now handled in worker-service.ts start command (issue #484)
 * This function logs for informational purposes only
 */
async function checkWorkerVersion(): Promise<void> {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();

  if (pluginVersion !== workerVersion) {
    // Just log debug info - auto-restart handles the mismatch in worker-service.ts
    logger.debug('SYSTEM', 'Version check', {
      pluginVersion,
      workerVersion,
      note: 'Mismatch will be auto-restarted by worker-service start command'
    });
  }
}


/**
 * Ensure worker service is running
 * Polls until worker is ready (assumes worker-service.cjs start was called by hooks.json)
 * Returns true if worker is healthy, false if not reachable (fails gracefully)
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  const maxRetries = 15;  // 3 seconds total (reduced from 15s to avoid blocking)
  const pollInterval = 200;

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (await isWorkerHealthy()) {
        await checkWorkerVersion();  // logs warning on mismatch, doesn't restart
        return true;
      }
    } catch (e) {
      logger.debug('SYSTEM', 'Worker health check failed, will retry', {
        attempt: i + 1,
        maxRetries,
        error: e instanceof Error ? e.message : String(e)
      });
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // Graceful degradation: log warning and continue without memory features
  const workerUrl = getWorkerUrl();
  logger.warn('SYSTEM', 'Worker not reachable - memory features disabled for this session', {
    workerUrl,
    timeoutMs: maxRetries * pollInterval
  });
  return false;
}

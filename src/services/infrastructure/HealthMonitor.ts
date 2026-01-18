/**
 * HealthMonitor - Port monitoring, health checks, and version checking
 *
 * Extracted from worker-service.ts monolith to provide centralized health monitoring.
 * Handles:
 * - Port availability checking
 * - Worker health/readiness polling
 * - Version mismatch detection (critical for plugin updates)
 * - HTTP-based shutdown requests
 */

import path from 'path';
import { homedir } from 'os';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getWorkerConnectHost, fetchWithTimeout } from '../../shared/worker-utils.js';

// Default timeout for health check fetches (3 seconds)
const FETCH_TIMEOUT_MS = 3000;

/**
 * Check if a port is in use by querying the health endpoint
 */
export async function isPortInUse(port: number): Promise<boolean> {
  const host = getWorkerConnectHost();
  // Use Promise.race timeout to avoid blocking when worker is unreachable
  const response = await fetchWithTimeout(`http://${host}:${port}/api/health`, FETCH_TIMEOUT_MS);
  return response?.ok ?? false;
}

/**
 * Wait for the worker to become fully ready (passes readiness check)
 * @param port Worker port to check
 * @param timeoutMs Maximum time to wait in milliseconds
 * @returns true if worker became ready, false if timeout
 */
export async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const host = getWorkerConnectHost();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Use Promise.race timeout to avoid blocking when worker is unreachable
    const response = await fetchWithTimeout(`http://${host}:${port}/api/readiness`, FETCH_TIMEOUT_MS);
    if (response?.ok) return true;
    logger.debug('SYSTEM', 'Service not ready yet, will retry', { port, host });
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Wait for a port to become free (no longer responding to health checks)
 * Used after shutdown to confirm the port is available for restart
 */
export async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Send HTTP shutdown request to a running worker
 * @param port Worker port
 * @returns true if shutdown request was acknowledged, false otherwise
 */
export async function httpShutdown(port: number): Promise<boolean> {
  const host = getWorkerConnectHost();
  // Note: fetchWithTimeout doesn't support POST method, so we use a custom wrapper
  const timeoutPromise = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), FETCH_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      fetch(`http://${host}:${port}/api/admin/shutdown`, { method: 'POST' }),
      timeoutPromise
    ]);

    if (!result) {
      logger.warn('SYSTEM', 'Shutdown request timed out', { port, host });
      return false;
    }

    if (!result.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', { port, host, status: result.status });
      return false;
    }
    return true;
  } catch (error) {
    // Connection refused is expected if worker already stopped
    if (error instanceof Error && error.message?.includes('ECONNREFUSED')) {
      logger.debug('SYSTEM', 'Worker already stopped', { port, host }, error);
      return false;
    }
    // Network error or unexpected - log and return false
    logger.debug('SYSTEM', 'Shutdown request failed', { port, host }, error as Error);
    return false;
  }
}

/**
 * Get the plugin version from the installed marketplace package.json
 * This is the "expected" version that should be running
 */
export function getInstalledPluginVersion(): string {
  const marketplaceRoot = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'rpirruccio');
  const packageJsonPath = path.join(marketplaceRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

/**
 * Get the running worker's version via API
 * This is the "actual" version currently running
 */
export async function getRunningWorkerVersion(port: number): Promise<string | null> {
  const host = getWorkerConnectHost();
  // Use Promise.race timeout to avoid blocking when worker is unreachable
  const response = await fetchWithTimeout(`http://${host}:${port}/api/version`, FETCH_TIMEOUT_MS);
  if (!response?.ok) {
    logger.debug('SYSTEM', 'Could not fetch worker version', { port, host });
    return null;
  }
  try {
    const data = await response.json() as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

export interface VersionCheckResult {
  matches: boolean;
  pluginVersion: string;
  workerVersion: string | null;
}

/**
 * Check if worker version matches plugin version
 * Critical for detecting when plugin is updated but worker is still running old code
 * Returns true if versions match or if we can't determine (assume match for graceful degradation)
 */
export async function checkVersionMatch(port: number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  // If we can't get worker version, assume it matches (graceful degradation)
  if (!workerVersion) {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}

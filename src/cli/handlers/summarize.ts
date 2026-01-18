/**
 * Summarize Handler - Stop
 *
 * Extracted from summary-hook.ts - sends summary request to worker.
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerUrl, fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Check if worker is running - if not, continue without memory features
    const workerAvailable = await ensureWorkerRunning();
    if (!workerAvailable) {
      return { continue: true, suppressOutput: true };
    }

    const { sessionId, transcriptPath } = input;

    // Validate required fields before processing
    if (!transcriptPath) {
      throw new Error(`Missing transcriptPath in Stop hook input for session ${sessionId}`);
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);

    const workerUrl = getWorkerUrl();
    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      workerUrl,
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    // Send to worker with timeout - gracefully degrade if worker becomes unavailable
    try {
      const response = await fetchWithTimeout(`${workerUrl}/api/sessions/summarize`, 3000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          last_assistant_message: lastAssistantMessage
        })
      });

      if (!response) {
        logger.warn('HOOK', 'Stop: Worker unavailable, summary not stored');
        return { continue: true, suppressOutput: true };
      }

      if (!response.ok) {
        logger.warn('HOOK', `Stop: Summary request failed (${response.status})`);
        return { continue: true, suppressOutput: true };
      }

      logger.debug('HOOK', 'Summary request sent successfully');
    } catch (error) {
      logger.warn('HOOK', 'Stop: Worker not reachable, summary not stored', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return { continue: true, suppressOutput: true };
  }
};

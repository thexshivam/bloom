'use strict';

const { findRecordingBySessionId, updateRecording, getOrphanedRecordings } = require('../db/database');
const { indexVideo } = require('./insights.service');

// --- Singleton state ---

/** CaptureClient instance (created per recording session) */
let captureClient = null;

/** Cached client session token (valid ~24 h) */
let cachedSessionToken = null;
let tokenExpiresAt = null;

// --- Token management ---

/**
 * Get or generate a session token for CaptureClient.
 * Caches the token until 5 minutes before expiry.
 */
async function getSessionToken(videodbService, apiKey) {
  if (cachedSessionToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    console.log('Using cached session token (expires in', Math.round((tokenExpiresAt - Date.now()) / 1000 / 60), 'minutes)');
    return cachedSessionToken;
  }

  if (!apiKey) {
    console.warn('No API key available. Please register first.');
    return null;
  }

  try {
    console.log('Generating session token via VideoDB SDK...');
    const tokenData = await videodbService.generateSessionToken(apiKey);
    if (tokenData && tokenData.sessionToken) {
      cachedSessionToken = tokenData.sessionToken;
      const expiresInMs = (tokenData.expiresIn || 3600) * 1000;
      tokenExpiresAt = Date.now() + expiresInMs - (5 * 60 * 1000); // 5 min buffer
      return cachedSessionToken;
    }
  } catch (error) {
    console.error('Error generating session token:', error);
  }
  return null;
}

/**
 * Clear cached session token (e.g. on logout).
 */
function clearSessionToken() {
  cachedSessionToken = null;
  tokenExpiresAt = null;
}

// --- Background indexing ---

/**
 * Run indexing (transcript + subtitles) for an exported video.
 * Updates the recording row in DB as it progresses.
 */
async function processIndexingBackground(recordingId, videoId, apiKey) {
  try {
    updateRecording(recordingId, { insights_status: 'processing' });
    console.log(`[Index] Starting indexing for recording ${recordingId}`);

    const result = await indexVideo(videoId, apiKey);

    if (result) {
      const updates = { insights_status: 'ready' };
      if (result.transcript) {
        updates.insights = JSON.stringify({ transcript: result.transcript });
      }
      if (result.subtitleUrl) {
        updates.stream_url = result.subtitleUrl;
        const { getRecordingById } = require('../db/database');
        const recording = getRecordingById(recordingId);
        if (recording && recording.player_url && recording.player_url.includes('url=')) {
          updates.player_url = recording.player_url.replace(/url=[^&]+/, `url=${result.subtitleUrl}`);
        } else {
          updates.player_url = result.subtitleUrl;
        }
      }
      updateRecording(recordingId, updates);
      console.log(`[Index] Indexed video ${videoId} successfully`);
    } else {
      updateRecording(recordingId, { insights_status: 'failed' });
      console.warn(`[Index] Failed to index video ${videoId}`);
    }
  } catch (err) {
    console.error(`[Index] Error processing:`, err);
    try {
      updateRecording(recordingId, { insights_status: 'failed' });
    } catch (_) { /* ignore DB errors during error handling */ }
  }
}

// --- Polling ---

/**
 * Poll a capture session's status until exported or failed.
 * Called after stop to wait for server-side export to complete.
 */
async function syncCaptureSession(sessionId, apiKey, videodbService) {
  const POLL_INTERVAL = 10_000;
  const MAX_ATTEMPTS = 60; // ~10 min max
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      const session = await videodbService.getCaptureSession(apiKey, sessionId);

      if (session.exportedVideoId) {
        console.log(`[Sync] Exported video received: ${session.exportedVideoId}`);
        const recording = findRecordingBySessionId(sessionId);
        if (recording && !recording.video_id) {
          updateRecording(recording.id, {
            video_id: session.exportedVideoId,
            stream_url: session.streamUrl,
            player_url: session.playerUrl,
            insights_status: 'pending',
          });
          processIndexingBackground(recording.id, session.exportedVideoId, apiKey);
        }
        return;
      }

      if (session.status === 'failed') {
        console.log(`[Sync] Session failed: ${sessionId}`);
        const recording = findRecordingBySessionId(sessionId);
        if (recording) updateRecording(recording.id, { insights_status: 'failed' });
        return;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    } catch (err) {
      console.error(`[Sync] Error:`, err.message);
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }
  console.warn(`[Sync] Gave up polling session ${sessionId} after ${MAX_ATTEMPTS} attempts`);
}

/**
 * On startup, check for recordings that started but never got an export event.
 */
async function syncOrphanedSessions(apiKey, videodbService) {
  if (!apiKey) return;

  const orphaned = getOrphanedRecordings();
  if (orphaned.length === 0) return;

  console.log(`[Sync] Found ${orphaned.length} orphaned recording(s), syncing...`);
  for (const rec of orphaned) {
    await syncCaptureSession(rec.session_id, apiKey, videodbService);
  }
}

/**
 * Single-pass check for all unresolved recordings (no video_id).
 * Makes one API call per recording — no retries or polling loop.
 * Used by the manual refresh button in the history window.
 */
async function checkPendingRecordings(apiKey, videodbService) {
  if (!apiKey) return 0;

  const orphaned = getOrphanedRecordings();
  if (orphaned.length === 0) return 0;

  let resolved = 0;
  console.log(`[Refresh] Checking ${orphaned.length} pending recording(s)...`);

  for (const rec of orphaned) {
    try {
      const session = await videodbService.getCaptureSession(apiKey, rec.session_id);

      if (session.exportedVideoId) {
        updateRecording(rec.id, {
          video_id: session.exportedVideoId,
          stream_url: session.streamUrl,
          player_url: session.playerUrl,
          insights_status: 'pending',
        });
        processIndexingBackground(rec.id, session.exportedVideoId, apiKey);
        resolved++;
      } else if (session.status === 'failed') {
        updateRecording(rec.id, { insights_status: 'failed' });
        resolved++;
      }
    } catch (err) {
      console.error(`[Refresh] Error checking session ${rec.session_id}:`, err.message);
    }
  }

  console.log(`[Refresh] Resolved ${resolved}/${orphaned.length} recording(s)`);
  return resolved;
}

// --- CaptureClient lifecycle ---

function getCaptureClient() {
  return captureClient;
}

function setCaptureClient(client) {
  captureClient = client;
}

/**
 * Graceful shutdown of capture client.
 */
async function shutdownSession() {
  if (captureClient) {
    try {
      await captureClient.shutdown();
      console.log('CaptureClient shutdown complete');
    } catch (error) {
      console.error('Error during SDK shutdown:', error);
    }
    captureClient = null;
  }
}

module.exports = {
  // Token
  getSessionToken,
  clearSessionToken,
  // Indexing
  processIndexingBackground,
  // Sync / polling
  syncCaptureSession,
  syncOrphanedSessions,
  checkPendingRecordings,
  // CaptureClient accessors
  getCaptureClient,
  setCaptureClient,
  // Lifecycle
  shutdownSession,
};

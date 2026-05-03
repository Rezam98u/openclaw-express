import crypto from "crypto";
import { bufferToExcelContext } from "./excelContext.js";

/**
 * In-memory session cache for Excel files.
 * Each session stores parsed Excel data keyed by a UUID.
 * Clients upload once, get a sessionId, then reuse it in future requests.
 */
const sessions = new Map();

/**
 * Create a new Excel session from a file buffer.
 * @param {Buffer} fileBuffer - Excel file as Buffer
 * @param {object} [opts] - Options for excelContext parsing
 * @param {string} [opts.sheetName] - Specific sheet name to parse
 * @param {number} [opts.maxChars] - Max characters to extract
 * @returns {string} - sessionId (UUID) to reference this Excel in future requests
 */
export function createExcelSession(fileBuffer, opts = {}) {
  const sessionId = crypto.randomUUID();
  const excelData = bufferToExcelContext(fileBuffer, opts);

  sessions.set(sessionId, {
    uploadedAt: new Date(),
    excelData,
    fileHash: crypto.createHash("sha256").update(fileBuffer).digest("hex"),
  });

  console.log(`[excel-session] Created session ${sessionId.slice(0, 8)}...`);
  return sessionId;
}

/**
 * Retrieve parsed Excel data for a session.
 * @param {string} sessionId - The session ID returned from createExcelSession
 * @returns {{ text: string; meta: object } | null} - Parsed Excel or null if expired/not found
 */
export function getExcelSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.warn(`[excel-session] Session not found: ${sessionId.slice(0, 8)}...`);
    return null;
  }

  // Update last accessed time (optional: for cleanup)
  session.lastAccessedAt = new Date();
  return session.excelData;
}

/**
 * Delete a specific session.
 * @param {string} sessionId
 * @returns {boolean} - True if deleted, false if not found
 */
export function deleteExcelSession(sessionId) {
  const deleted = sessions.delete(sessionId);
  if (deleted) {
    console.log(`[excel-session] Deleted session ${sessionId.slice(0, 8)}...`);
  }
  return deleted;
}

/**
 * Get metadata about all active sessions (for monitoring/admin).
 * @returns {array} - Array of session info
 */
export function listExcelSessions() {
  return Array.from(sessions.entries()).map(([id, data]) => ({
    sessionId: id,
    uploadedAt: data.uploadedAt,
    lastAccessedAt: data.lastAccessedAt || null,
    sheetName: data.excelData.meta.sheetName,
    rowCount: data.excelData.meta.rowCount,
    colCount: data.excelData.meta.colCount,
    charCount: data.excelData.meta.charCount,
    fileHash: data.fileHash.slice(0, 12),
  }));
}

/**
 * Clear all sessions (useful for testing or cleanup).
 */
export function clearAllExcelSessions() {
  const count = sessions.size;
  sessions.clear();
  console.log(`[excel-session] Cleared ${count} sessions`);
}

/**
 * Optional: Auto-cleanup sessions older than maxAgeMs (default 24 hours).
 * Call periodically or on shutdown.
 * @param {number} [maxAgeMs] - Max age in milliseconds (default 24h)
 */
export function cleanupExpiredSessions(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = new Date();
  let cleaned = 0;

  for (const [sessionId, data] of sessions.entries()) {
    const age = now - data.uploadedAt;
    if (age > maxAgeMs) {
      sessions.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[excel-session] Cleaned up ${cleaned} expired sessions`);
  }
}

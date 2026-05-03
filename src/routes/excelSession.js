import { Router } from "express";
import multer from "multer";
import {
  createExcelSession,
  getExcelSession,
  deleteExcelSession,
  listExcelSessions,
} from "../utils/excelSessionCache.js";

export const excelSessionRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    const nameOk = /\.(xlsx|xls)$/i.test(file.originalname || "");
    const mimeOk =
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel";
    if (nameOk || mimeOk) cb(null, true);
    else cb(new Error("Invalid file type; upload .xlsx or .xls"));
  },
});

/**
 * POST /api/excel-session/upload
 *
 * Upload an Excel file and get a sessionId to reuse in future requests.
 *
 * Request: multipart/form-data
 *   - file: .xlsx or .xls
 *   - sheetName: (optional) specific worksheet name
 *
 * Response:
 *   {
 *     "sessionId": "uuid-string",
 *     "excelData": {
 *       "text": "TSV content...",
 *       "meta": { "sheetName", "rowCount", "colCount", "charCount", ... }
 *     }
 *   }
 */
excelSessionRouter.post(
  "/upload",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            error: `File too large; max ${MAX_UPLOAD_BYTES} bytes`,
          });
        }
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: err.message });
    });
  },
  async (req, res) => {
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ error: "File field 'file' is required." });
    }

    const sheetName =
      typeof req.body?.sheetName === "string" ? req.body.sheetName : undefined;

    try {
      const sessionId = createExcelSession(file.buffer, { sheetName });
      const excelData = getExcelSession(sessionId);

      res.json({
        sessionId,
        excelData,
      });
    } catch (err) {
      console.error("[excel-session:upload]", err);
      res.status(400).json({
        error: "Failed to parse Excel file.",
        detail: err.message,
      });
    }
  }
);

/**
 * GET /api/excel-session/:sessionId
 *
 * Retrieve previously uploaded Excel data by sessionId.
 *
 * Response:
 *   {
 *     "sessionId": "uuid-string",
 *     "excelData": { "text": "...", "meta": { ... } }
 *   }
 *
 * 404 if sessionId not found or expired.
 */
excelSessionRouter.get("/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const excelData = getExcelSession(sessionId);
  if (!excelData) {
    return res.status(404).json({
      error: "Excel session not found or expired.",
      sessionId,
    });
  }

  res.json({
    sessionId,
    excelData,
  });
});

/**
 * DELETE /api/excel-session/:sessionId
 *
 * Delete a session and free memory.
 *
 * Response: { "deleted": true } or 404
 */
excelSessionRouter.delete("/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  const deleted = deleteExcelSession(sessionId);
  if (!deleted) {
    return res.status(404).json({
      error: "Excel session not found.",
      sessionId,
    });
  }

  res.json({ deleted: true, sessionId });
});

/**
 * GET /api/excel-session
 *
 * List all active Excel sessions (useful for debugging/admin).
 *
 * Response:
 *   [
 *     { "sessionId": "...", "uploadedAt": "...", "rowCount": 42, ... },
 *     ...
 *   ]
 */
excelSessionRouter.get("/", (req, res) => {
  const sessions = listExcelSessions();
  res.json(sessions);
});

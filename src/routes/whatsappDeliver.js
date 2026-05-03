import { Router } from "express";
import multer from "multer";
import { getClient } from "../openclawClient.js";
import { bufferToExcelContext } from "../utils/excelContext.js";
import { collectAgentTextStream } from "../utils/agentStreamCollect.js";
import {
  buildWhatsAppDmSessionKey,
  isValidE164,
  normalizeE164,
} from "../utils/whatsappSession.js";

export const whatsappDeliverRouter = Router();

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

/** When the form does not set `extraSystemPrompt`, this prefixes the sheet TSV on the system side. */
const DEFAULT_SYSTEM_WHEN_EXCEL =
  "You are a dating message coach. Use the guidelines and examples below.";

/**
 * System-side prompt (gateway `extraSystemPrompt`): persona + spreadsheet TSV.
 * User-side content is only `task` (see handler).
 *
 * @param {string} excelText
 * @param {string | undefined} formSystemPrompt
 * @returns {string | undefined}
 */
function buildExtraSystemPrompt(excelText, formSystemPrompt) {
  const excel = excelText.trim();
  const userBase =
    typeof formSystemPrompt === "string" && formSystemPrompt.trim()
      ? formSystemPrompt.trim()
      : null;
  const base = userBase ?? (excel ? DEFAULT_SYSTEM_WHEN_EXCEL : null);

  if (!base && !excel) return undefined;

  if (excel) {
    const block = `Guidelines and examples (spreadsheet as TSV):\n\`\`\`\n${excel}\n\`\`\``;
    return base ? `${base}\n\n${block}` : block;
  }
  return base;
}

whatsappDeliverRouter.post(
  "/ask-deliver",
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
    const task = req.body?.task ?? req.body?.question;
    const to = req.body?.to;
    let agentId = "main";
    if (typeof req.body?.agentId === "string" && req.body.agentId.trim()) {
      agentId = req.body.agentId.trim();
    }
    const sheetName =
      typeof req.body?.sheetName === "string" ? req.body.sheetName : undefined;
    let systemPromptFromForm;
    if (
      typeof req.body?.extraSystemPrompt === "string" &&
      req.body.extraSystemPrompt.trim()
    ) {
      systemPromptFromForm = req.body.extraSystemPrompt.trim();
    }

    if (typeof task !== "string" || !task.trim()) {
      return res
        .status(400)
        .json({ error: "Field 'task' (string) is required (alias: 'question')." });
    }
    if (typeof to !== "string" || !isValidE164(to)) {
      return res.status(400).json({
        error:
          "Field 'to' must be a full E.164 phone number (e.g. +15551234567).",
      });
    }

    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ error: "Spreadsheet file field 'file' is required." });
    }

    const { text: excelText, meta: contextMeta } = bufferToExcelContext(
      file.buffer,
      { sheetName }
    );
    const extraSystemPrompt = buildExtraSystemPrompt(excelText, systemPromptFromForm);
    const message = task.trim();
    const sessionKey = buildWhatsAppDmSessionKey(agentId, normalizeE164(to));

    try {
      const client = await getClient();
      const chatOpts = {
        sessionKey,
        agentId,
        deliver: true,
        channel: "whatsapp",
        ...(extraSystemPrompt !== undefined && { extraSystemPrompt }),
      };

      const { answer, streamError } = await collectAgentTextStream(
        client.chat(message, chatOpts)
      );

      if (streamError) {
        return res.status(502).json({
          error: "Agent run failed before a complete reply.",
          detail: streamError,
          answer,
          sessionKey,
          deliveryRequested: true,
          delivered: false,
          contextMeta,
        });
      }

      const hasText = answer.trim().length > 0;
      res.json({
        answer,
        sessionKey,
        deliveryRequested: true,
        delivered: hasText,
        ...(hasText
          ? {}
          : {
              hint:
                "No assistant text was streamed. Check the OpenClaw gateway logs and the WhatsApp thread; delivery may still have occurred depending on gateway behavior.",
            }),
        contextMeta,
      });
    } catch (err) {
      console.error("[whatsapp:ask-deliver]", err);
      res.status(502).json({
        error: "Failed to reach OpenClaw gateway or delivery failed.",
        detail: err?.message ?? String(err),
        sessionKey,
        contextMeta,
      });
    }
  }
);

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
    const ok =
      /\.(xlsx|xls)$/i.test(file.originalname || "") ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel";
    cb(ok ? null : new Error("Invalid file type; upload .xlsx or .xls"), ok);
  },
});

// One-shot flow:
//   - sessionKey uses the WhatsApp DM convention (agent:<id>:whatsapp:dm:<e164>)
//     so the gateway can route delivery to the right number.
//   - session is reset before every call -> no history accumulates between calls.
//   - spreadsheet is inlined into the single message -> never lives in history.
whatsappDeliverRouter.post("/ask-deliver", upload.single("file"), async (req, res) => {
  const task = (req.body?.task ?? req.body?.question ?? "").trim();
  const to = req.body?.to;
  const agentId = req.body?.agentId?.trim() || "main";
  const sheetName = req.body?.sheetName;

  if (!task) return res.status(400).json({ error: "Field 'task' (string) is required." });
  if (!to || !isValidE164(to)) return res.status(400).json({ error: "Valid E.164 'to' field required." });
  if (!req.file?.buffer) return res.status(400).json({ error: "Spreadsheet file 'file' is required." });

  const { text: excelText, meta: contextMeta } = bufferToExcelContext(req.file.buffer, { sheetName });
  const recipient = normalizeE164(to);
  const sessionKey = buildWhatsAppDmSessionKey(agentId, recipient);

  const message = [
    "Spreadsheet (TSV):",
    "```",
    excelText,
    "```",
    "",
    `Task: ${task}`,
  ].join("\n");

  try {
    const client = await getClient();

    // Wipe prior history so each request is a single fresh turn.
    // Ignore failure if the session doesn't exist yet.
    await client.sessions.reset(sessionKey, { reason: "new" }).catch(() => {});

    const { answer, streamError } = await collectAgentTextStream(
      client.chat(message, { sessionKey, agentId, deliver: true, channel: "whatsapp" })
    );

    if (streamError) {
      return res.status(502).json({
        error: "Agent run failed.",
        detail: streamError,
        answer,
        sessionKey,
        deliveryRequested: true,
        delivered: false,
        contextMeta,
      });
    }

    res.json({
      answer,
      sessionKey,
      deliveryRequested: true,
      delivered: !!answer.trim(),
      contextMeta,
    });
  } catch (err) {
    console.error("[whatsapp:ask-deliver]", err);
    res.status(502).json({ error: "Gateway failed.", detail: err.message, sessionKey, contextMeta });
  }
});

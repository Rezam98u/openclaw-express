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
import { createExcelSession, getExcelSession } from "../utils/excelSessionCache.js";

export const whatsappDeliverRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const sessionExcelCache = new Map(); // sessionKey -> boolean

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    const isValid = /\.(xlsx|xls)$/i.test(file.originalname || "") ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel";
    cb(isValid ? null : new Error("Invalid file type; upload .xlsx or .xls"), isValid);
  },
});

async function loadExcelToSession(client, sessionKey, agentId, excelText) {
  await client.chatSync(
    `REFERENCE DATA (store in memory):\n\`\`\`\n${excelText}\n\`\`\`\nUse this data for the conversation.`,
    { sessionKey, agentId }
  );
  sessionExcelCache.set(sessionKey, true);
  setTimeout(() => sessionExcelCache.delete(sessionKey), 3600000); // 1hr timeout
}

whatsappDeliverRouter.post("/ask-deliver", upload.single("file"), async (req, res) => {
  const task = req.body?.task ?? req.body?.question;
  const to = req.body?.to;
  const agentId = req.body?.agentId?.trim() || "main";
  const sheetName = req.body?.sheetName;
  const forceReload = req.body?.forceReload === true || req.body?.forceReload === "true";

  if (!task?.trim()) return res.status(400).json({ error: "Field 'task' (string) is required." });
  if (!to || !isValidE164(to)) return res.status(400).json({ error: "Valid E.164 'to' field required." });
  if (!req.file?.buffer) return res.status(400).json({ error: "Spreadsheet file 'file' is required." });

  const { text: excelText, meta: contextMeta } = bufferToExcelContext(req.file.buffer, { sheetName });
  const sessionKey = buildWhatsAppDmSessionKey(agentId, normalizeE164(to));
  const message = task.trim();

  try {
    const client = await getClient();
    const hasExcel = sessionExcelCache.get(sessionKey);

    if (!hasExcel || forceReload) {
      await loadExcelToSession(client, sessionKey, agentId, excelText);
    }

    const { answer, streamError } = await collectAgentTextStream(
      client.chat(message, { sessionKey, agentId, deliver: true, channel: "whatsapp" })
    );

    if (streamError) {
      return res.status(502).json({ error: "Agent run failed.", detail: streamError, answer, sessionKey, deliveryRequested: true, delivered: false, contextMeta });
    }

    res.json({ answer, sessionKey, deliveryRequested: true, delivered: !!answer.trim(), contextMeta, excelLoaded: !forceReload && !!hasExcel });
  } catch (err) {
    console.error("[whatsapp:ask-deliver]", err);
    res.status(502).json({ error: "Gateway failed.", detail: err.message, sessionKey, contextMeta });
  }
});
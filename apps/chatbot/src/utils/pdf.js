import PDFDocument from "pdfkit";
import { query, queryOne } from "../db.js";

export async function streamChatPdf(res, sessionId, user) {
  const session = await queryOne(
    "SELECT id, title FROM chat_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, user.id]
  );
  if (!session) {
    res.status(404).json({ ok: false, error: { message: "Chat session not found" } });
    return;
  }

  const messages = await query(
    `SELECT role, content, created_at
     FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="chat-${sessionId}.pdf"`);

  const doc = new PDFDocument({ margin: 42, size: "A4" });
  doc.pipe(res);
  doc.fontSize(18).text("SR Groups Local AI Chat Export", { align: "center" });
  doc.moveDown(0.5).fontSize(11).fillColor("#555").text(session.title, { align: "center" });
  doc.moveDown();

  for (const message of messages) {
    const label = message.role === "assistant" ? "Assistant" : message.role === "user" ? "You" : message.role;
    doc.fillColor("#111").fontSize(11).font("Helvetica-Bold").text(`${label} • ${message.created_at}`);
    doc.font("Helvetica").fillColor("#222").fontSize(10).text(message.content, {
      width: 510,
      align: "left"
    });
    doc.moveDown();
  }

  doc.end();
}

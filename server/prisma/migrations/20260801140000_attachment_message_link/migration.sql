-- ─────────────────────────────────────────────────────────────
-- Link an attachment to the reply that carried it
--
-- Attachments were only ever tied to the ticket, so every file — whether sent
-- with the opening description or with a reply twenty minutes later — rendered
-- in one undifferentiated list beside the conversation. A screenshot sent to
-- illustrate a specific point arrived detached from the point.
--
-- Nullable: files attached when the ticket was raised belong to the ticket
-- itself and have no message to hang from, and every existing row is one of
-- those.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "ticket_attachments" ADD COLUMN "messageId" TEXT;

CREATE INDEX "ticket_attachments_messageId_idx" ON "ticket_attachments"("messageId");

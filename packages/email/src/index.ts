import { env } from "@hootifactory/config";
import { logger, withSpan } from "@hootifactory/observability";
import { EMAIL_TEMPLATE } from "@hootifactory/types";
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";

const emailJobBaseShape = {
  to: z.string().min(1),
  expiresAt: z.string().min(1),
  deliveryKey: z.string().min(1),
};

/**
 * Wire schema for a queued email. pg-boss job data is plain JSON read back from
 * the database, so the worker must not trust it to match {@link EmailJob}:
 * {@link parseEmailJob} validates every payload at the dequeue boundary (issue
 * #308). Unknown keys (e.g. the telemetry context carrier stamped at enqueue)
 * are stripped, not rejected.
 */
export const EmailJobSchema = z.discriminatedUnion("template", [
  z.object({
    template: z.literal(EMAIL_TEMPLATE.passwordReset),
    resetUrl: z.string().min(1),
    ...emailJobBaseShape,
  }),
  z.object({
    template: z.literal(EMAIL_TEMPLATE.oidcLink),
    linkUrl: z.string().min(1),
    providerName: z.string().min(1),
    ...emailJobBaseShape,
  }),
]);

/**
 * A queued email. `deliveryKey` is mandatory: it is the idempotency identity of
 * the send (pg-boss singleton key, `email_deliveries` claim key, and the SMTP
 * Message-ID), so every enqueue site must derive a deterministic key — without
 * one, a re-delivered queue message would double-send.
 */
export type EmailJob = z.output<typeof EmailJobSchema>;

/** Thrown when a dequeued email.send payload does not match {@link EmailJobSchema}. */
export class InvalidEmailJobError extends Error {
  constructor(detail: string) {
    super(`invalid email job payload: ${detail}`);
    this.name = "InvalidEmailJobError";
  }
}

/**
 * Parse an untrusted queue payload into an {@link EmailJob}, throwing a
 * readable {@link InvalidEmailJobError} (one "path: message" entry per issue)
 * instead of an opaque ZodError so the failed job's last error explains what
 * was malformed.
 */
export function parseEmailJob(data: unknown): EmailJob {
  const parsed = EmailJobSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(payload)"}: ${issue.message}`)
    .join("; ");
  throw new InvalidEmailJobError(detail);
}

export interface RenderedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let transporter: Transporter | null = null;

export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user?: string;
  password?: string;
}

export function buildSmtpTransportOptions(config: SmtpTransportConfig) {
  const auth =
    config.user || config.password
      ? { user: config.user ?? "", pass: config.password ?? "" }
      : undefined;
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    auth,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function expiryText(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toISOString();
}

export function renderEmail(job: EmailJob): RenderedEmail {
  if (job.template === EMAIL_TEMPLATE.passwordReset) {
    const expires = expiryText(job.expiresAt);
    return {
      to: job.to,
      subject: "Reset your Hootifactory password",
      text: [
        "A password reset was requested for your Hootifactory account.",
        "",
        `Reset password: ${job.resetUrl}`,
        "",
        `This link expires at ${expires}.`,
        "If you did not request this, you can ignore this email.",
      ].join("\n"),
      html: [
        "<p>A password reset was requested for your Hootifactory account.</p>",
        `<p><a href="${escapeHtml(job.resetUrl)}">Reset password</a></p>`,
        `<p>This link expires at ${escapeHtml(expires)}.</p>`,
        "<p>If you did not request this, you can ignore this email.</p>",
      ].join(""),
    };
  }

  const expires = expiryText(job.expiresAt);
  return {
    to: job.to,
    subject: "Confirm your Hootifactory sign-in",
    text: [
      `A ${job.providerName} sign-in wants to link to this Hootifactory account.`,
      "",
      `Confirm sign-in: ${job.linkUrl}`,
      "",
      `This link expires at ${expires}.`,
      "If you did not try to sign in, you can ignore this email.",
    ].join("\n"),
    html: [
      `<p>A ${escapeHtml(job.providerName)} sign-in wants to link to this Hootifactory account.</p>`,
      `<p><a href="${escapeHtml(job.linkUrl)}">Confirm sign-in</a></p>`,
      `<p>This link expires at ${escapeHtml(expires)}.</p>`,
      "<p>If you did not try to sign in, you can ignore this email.</p>",
    ].join(""),
  };
}

function smtpTransport(): Transporter {
  if (transporter) return transporter;
  if (!env.EMAIL_SMTP_HOST) throw new Error("EMAIL_SMTP_HOST is required to send email");
  transporter = nodemailer.createTransport(
    buildSmtpTransportOptions({
      host: env.EMAIL_SMTP_HOST,
      port: env.EMAIL_SMTP_PORT,
      secure: env.EMAIL_SMTP_SECURE,
      requireTLS: env.EMAIL_SMTP_REQUIRE_TLS,
      user: env.EMAIL_SMTP_USER,
      password: env.EMAIL_SMTP_PASSWORD,
    }),
  );
  return transporter;
}

/**
 * Render and deliver a job over the given transport, recording span attributes
 * and rejecting if the SMTP server declined any recipient (even a partial
 * rejection fails the send). The transport is a parameter so this can be
 * exercised without the SMTP/env machinery; `sendEmail` supplies the pooled
 * {@link smtpTransport}.
 */
export async function deliverEmail(job: EmailJob, transport: Transporter): Promise<void> {
  const message = renderEmail(job);
  await withSpan("email.send", { "email.template": job.template }, async (span) => {
    const info = await transport.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: `<${job.deliveryKey}@hootifactory.local>`,
    });
    span.setAttribute("email.message_id", info.messageId ?? "");
    span.setAttribute("email.accepted_count", info.accepted?.length ?? 0);
    span.setAttribute("email.rejected_count", info.rejected?.length ?? 0);
    if (info.rejected?.length) {
      throw new Error(`email rejected for ${info.rejected.length} recipient(s)`);
    }
    logger.info("email sent", {
      template: job.template,
      messageId: info.messageId,
      accepted: info.accepted?.length ?? 0,
    });
  });
}

export async function sendEmail(job: EmailJob): Promise<void> {
  if (!env.EMAIL_ENABLED) {
    logger.debug("email delivery skipped because EMAIL_ENABLED=false", { template: job.template });
    return;
  }
  await deliverEmail(job, smtpTransport());
}

export function closeEmailTransport(): void {
  transporter?.close();
  transporter = null;
}

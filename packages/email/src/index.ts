import { env } from "@hootifactory/config";
import { logger, withSpan } from "@hootifactory/observability";
import { EMAIL_TEMPLATE } from "@hootifactory/types";
import nodemailer, { type Transporter } from "nodemailer";

export type EmailJob =
  | {
      template: typeof EMAIL_TEMPLATE.passwordReset;
      to: string;
      resetUrl: string;
      expiresAt: string;
      deliveryKey?: string;
    }
  | {
      template: typeof EMAIL_TEMPLATE.oidcLink;
      to: string;
      linkUrl: string;
      providerName: string;
      expiresAt: string;
      deliveryKey?: string;
    };

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

export async function sendEmail(job: EmailJob): Promise<void> {
  if (!env.EMAIL_ENABLED) {
    logger.debug("email delivery skipped because EMAIL_ENABLED=false", { template: job.template });
    return;
  }
  const message = renderEmail(job);
  await withSpan("email.send", { "email.template": job.template }, async (span) => {
    const info = await smtpTransport().sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: job.deliveryKey ? `<${job.deliveryKey}@hootifactory.local>` : undefined,
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

export function closeEmailTransport(): void {
  transporter?.close();
  transporter = null;
}

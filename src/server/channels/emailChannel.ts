/**
 * Email Delivery Channel (SMTP via Nodemailer)
 * ============================================
 * Dispatches authoritative air quality alerts to verified recipients.
 * Enforces HTML entity escaping for all dynamic values to prevent injection.
 * Scrubs SMTP credentials from error logs.
 */

import nodemailer from 'nodemailer';
import type { StructuredAlertMessage, RecipientRecord } from '../../types/alertDelivery';
import type { ChannelSendResult } from './webhookChannel';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const renderEmailContent = (message: StructuredAlertMessage) => buildEmailContent(message);

export function buildEmailContent(message: StructuredAlertMessage): { text: string; html: string } {
  const safeStation = escapeHtml(message.station_name || message.station_id);
  const safeCity = escapeHtml(message.city);
  const safeTier = escapeHtml(message.tier);
  const safeProb = (message.probability * 100).toFixed(1);
  const safeExposed = Math.round(message.expected_people_exposed).toLocaleString('en-IN');
  const safeDisclaimer = escapeHtml(message.disclaimer);
  const safeCoordNote = message.coord_quality_note ? escapeHtml(message.coord_quality_note) : null;
  const safeDashboardUrl = escapeHtml(message.dashboard_url);
  const isTest = message.is_test === true;

  let observationAgeNote = message.observation_age_note;
  if (!observationAgeNote) {
    const ageHours = Math.max(
      0,
      (new Date().getTime() - new Date(message.source_observation_timestamp).getTime()) / (3600 * 1000)
    );
    const rounded = Math.round(ageHours * 10) / 10;
    const ageStr = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
    observationAgeNote = `Source observation: ${message.source_observation_timestamp}, ${ageStr} h ago at send time`;
  }
  const safeObsAge = escapeHtml(observationAgeNote);
  const safeIssuedLate = message.issued_late_note ? escapeHtml(message.issued_late_note) : null;

  const testPrefix = isTest ? '[TEST ALERT] ' : '';

  const text = `
${message.issued_late_note ? `${message.issued_late_note}\n` : ''}${testPrefix}VayuDrishti Acute Spike Alert
====================================================
Tier: ${message.tier.toUpperCase()} (${safeProb}% Risk Probability)
Station: ${message.station_name} (${message.station_id})
City: ${message.city}
Estimated Population Exposed (5km): ${safeExposed}
Observed At: ${message.source_observation_timestamp}
${observationAgeNote}
Model: ${message.model_version}

${safeCoordNote ? `${message.coord_quality_note}\n\n` : ''}Notice: ${message.disclaimer}

Dashboard: ${message.dashboard_url}
`.trim();

  const tierColor =
    message.tier === 'High' ? '#dc2626' : message.tier === 'Elevated' ? '#ea580c' : '#d97706';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${testPrefix}Air Quality Alert - ${safeCity}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1e293b; background-color: #f8fafc; margin: 0; padding: 24px;">
  <div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
    ${
      safeIssuedLate
        ? `<div style="background: #fef2f2; color: #991b1b; padding: 10px 16px; font-weight: 700; font-size: 13px; border-bottom: 1px solid #fecaca;">
             ⚠ ${safeIssuedLate}
           </div>`
        : ''
    }
    ${
      isTest
        ? `<div style="background: #fef3c7; color: #92400e; padding: 10px 16px; font-weight: 700; font-size: 13px; text-transform: uppercase; border-bottom: 1px solid #fde68a;">
             ⚠ DEMONSTRATION / TEST ALERT - NOT A REAL EMERGENCY
           </div>`
        : ''
    }
    <div style="background: ${tierColor}; padding: 18px 24px; color: #ffffff;">
      <h1 style="margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.02em;">
        ${testPrefix}VayuDrishti Alert: ${safeTier.toUpperCase()} Risk
      </h1>
      <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.95;">
        ${safeStation}, ${safeCity}
      </p>
    </div>

    <div style="padding: 24px;">
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; width: 40%;">Spike Probability:</td>
          <td style="padding: 8px 0; font-weight: 700; color: ${tierColor}; font-size: 16px;">${safeProb}%</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Risk Tier:</td>
          <td style="padding: 8px 0; font-weight: 600;">${safeTier}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b;">People Exposed (5km):</td>
          <td style="padding: 8px 0; font-weight: 600;">${safeExposed}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Telemetry Timestamp:</td>
          <td style="padding: 8px 0; color: #334155;">${escapeHtml(message.source_observation_timestamp)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Source Observation:</td>
          <td style="padding: 8px 0; color: #334155;">${safeObsAge}</td>
        </tr>
      </table>

      ${
        safeCoordNote
          ? `<div style="background: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #92400e; margin-bottom: 18px;">
               ${safeCoordNote}
             </div>`
          : ''
      }

      <div style="background: #f1f5f9; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #475569; margin-bottom: 20px;">
        <strong>Notice:</strong> ${safeDisclaimer}
      </div>

      <div style="text-align: center; margin-top: 24px;">
        <a href="${safeDashboardUrl}" style="background: #0f172a; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; display: inline-block;">
          View Observatory Dashboard
        </a>
      </div>
    </div>
  </div>
</body>
</html>
`.trim();

  return { text, html };
}

export async function sendEmailAlert(
  recipient: RecipientRecord,
  message: StructuredAlertMessage,
  idempotencyKey?: string
): Promise<ChannelSendResult> {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const fromAddress = process.env.ALERT_FROM_ADDRESS || 'VayuDrishti Alerts <alerts@vayudrishti.org>';

  if (!host || !user || !pass) {
    return {
      success: false,
      error: 'SMTP configuration is incomplete on server (missing SMTP_HOST, SMTP_USER, or SMTP_PASS).',
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 5000,
  });

  const { text, html } = buildEmailContent(message);
  const isTest = message.is_test === true;
  const subject = `${isTest ? '[TEST ALERT] ' : ''}Air Quality Alert [${message.tier.toUpperCase()}]: ${message.city} (${(message.probability * 100).toFixed(0)}%)`;

  const mailOptions: any = {
    from: fromAddress,
    to: recipient.destination,
    subject,
    text,
    html,
  };

  if (idempotencyKey) {
    mailOptions.messageId = `<${idempotencyKey}@alerts.vayudrishti.org>`;
  }

  try {
    const info = await transporter.sendMail(mailOptions);

    return {
      success: true,
      statusCode: 250,
      responseBody: String(info.response || info.messageId || 'Delivered').slice(0, 500),
    };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Scrub credentials
    const cleanMsg = rawMsg
      .replace(new RegExp(pass, 'g'), '[REDACTED]')
      .replace(new RegExp(user, 'g'), '[REDACTED]');

    return {
      success: false,
      error: `SMTP delivery failed: ${cleanMsg}`,
    };
  }
}

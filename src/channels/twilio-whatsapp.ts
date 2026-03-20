import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import twilio from 'twilio';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface TwilioWhatsAppConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string; // e.g. "whatsapp:+14155238886"
  port: number;
  webhookUrl: string; // Public URL for signature validation (empty = skip validation)
}

interface TwilioWhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Max message length for WhatsApp via Twilio */
const MAX_MESSAGE_LENGTH = 1600;

/**
 * Parse URL-encoded form body from Twilio webhook POST.
 */
function parseFormBody(body: Buffer): Record<string, string> {
  const params = new URLSearchParams(body.toString('utf-8'));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

export class TwilioWhatsAppChannel implements Channel {
  name = 'twilio-whatsapp';

  private server: Server | null = null;
  private client: twilio.Twilio;
  private config: TwilioWhatsAppConfig;
  private opts: TwilioWhatsAppChannelOpts;

  constructor(config: TwilioWhatsAppConfig, opts: TwilioWhatsAppChannelOpts) {
    this.config = config;
    this.opts = opts;
    this.client = twilio(config.accountSid, config.authToken);
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, '0.0.0.0', () => {
        logger.info(
          { port: this.config.port },
          'Twilio WhatsApp webhook listening',
        );
        console.log(
          `\n  Twilio WhatsApp webhook: http://0.0.0.0:${this.config.port}/webhook`,
        );
        console.log(`  Register chats with JID format: whatsapp:+PHONE\n`);
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error({ err }, 'Twilio webhook server error');
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const to = jid;

      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.client.messages.create({
          from: this.config.fromNumber,
          to,
          body: text,
        });
      } else {
        // Split long messages
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.client.messages.create({
            from: this.config.fromNumber,
            to,
            body: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }

      logger.info({ jid, length: text.length }, 'Twilio WhatsApp message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Twilio WhatsApp message');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('whatsapp:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('Twilio WhatsApp webhook server stopped');
          resolve();
        });
      });
    }
  }

  // --- Private ---

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', channel: 'twilio-whatsapp' }));
      return;
    }

    if (method === 'POST' && url === '/webhook') {
      this.handleWebhook(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const params = parseFormBody(body);

        // Validate Twilio signature if webhook URL is configured
        if (this.config.webhookUrl) {
          const signature = req.headers['x-twilio-signature'] as string;
          const valid = twilio.validateRequest(
            this.config.authToken,
            signature || '',
            this.config.webhookUrl,
            params,
          );
          if (!valid) {
            logger.warn('Twilio webhook: invalid signature');
            res.writeHead(403);
            res.end('Invalid signature');
            return;
          }
        }

        this.processInboundMessage(params);

        // Respond with TwiML acknowledgement so the user gets immediate feedback
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(
          '<Response><Message>Message received, thinking...</Message></Response>',
        );
      } catch (err) {
        logger.error({ err }, 'Error processing Twilio webhook');
        res.writeHead(500);
        res.end('Internal error');
      }
    });
  }

  private processInboundMessage(params: Record<string, string>): void {
    const from = params.From || '';
    const body = params.Body || '';
    const profileName = params.ProfileName || '';
    const messageSid = params.MessageSid || '';
    const numMedia = parseInt(params.NumMedia || '0', 10);

    if (!from) {
      logger.warn('Twilio webhook: missing From field');
      return;
    }

    const chatJid = from;
    const phone = from.replace(/^whatsapp:/, '');
    const timestamp = new Date().toISOString();

    // Build content with media placeholders
    let content = body;
    if (numMedia > 0) {
      const mediaPlaceholders: string[] = [];
      for (let i = 0; i < numMedia; i++) {
        const contentType = params[`MediaContentType${i}`] || 'unknown';
        mediaPlaceholders.push(`[Media: ${contentType}]`);
      }
      const mediaText = mediaPlaceholders.join(' ');
      content = content ? `${content}\n${mediaText}` : mediaText;
    }

    if (!content) {
      logger.debug({ chatJid }, 'Twilio webhook: empty message, skipping');
      return;
    }

    logger.info(
      { chatJid, profileName, numMedia, length: content.length },
      'Twilio WhatsApp message received',
    );

    // Store chat metadata for discovery
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      profileName || phone,
      'twilio-whatsapp',
      false, // Twilio WhatsApp is always 1:1
    );

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, profileName },
        'Message from unregistered Twilio WhatsApp chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: messageSid,
      chat_jid: chatJid,
      sender: phone,
      sender_name: profileName || phone,
      content,
      timestamp,
      is_from_me: false,
    });
  }
}

// --- Self-registration ---

registerChannel('twilio-whatsapp', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_FROM',
    'TWILIO_WEBHOOK_PORT',
    'TWILIO_WEBHOOK_URL',
  ]);

  const accountSid =
    process.env.TWILIO_ACCOUNT_SID || envVars.TWILIO_ACCOUNT_SID || '';
  const authToken =
    process.env.TWILIO_AUTH_TOKEN || envVars.TWILIO_AUTH_TOKEN || '';
  const fromNumber =
    process.env.TWILIO_WHATSAPP_FROM || envVars.TWILIO_WHATSAPP_FROM || '';
  const port = parseInt(
    process.env.TWILIO_WEBHOOK_PORT || envVars.TWILIO_WEBHOOK_PORT || '3002',
    10,
  );
  const webhookUrl =
    process.env.TWILIO_WEBHOOK_URL || envVars.TWILIO_WEBHOOK_URL || '';

  if (!accountSid || !authToken || !fromNumber) {
    logger.warn('Twilio WhatsApp: credentials not set, skipping');
    return null;
  }

  if (!webhookUrl) {
    logger.warn(
      'Twilio WhatsApp: TWILIO_WEBHOOK_URL not set, signature validation disabled',
    );
  }

  return new TwilioWhatsAppChannel(
    { accountSid, authToken, fromNumber, port, webhookUrl },
    opts,
  );
});

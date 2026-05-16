import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rm } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(__dirname, 'wa_auth');

let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;
let onMessageHandler = null;
let dbRef = null;
let manualDisconnect = false;
let adminGroupJid = null;
let groupCaptureCallback = null;
const sentByBot = new Set();

export function setAdminGroupJid(jid) { adminGroupJid = jid; }
export function startGroupCapture(callback) { groupCaptureCallback = callback; }
export function getAdminGroupJid() { return adminGroupJid; }

function setStatus(s) { connectionStatus = s; }

// Versão de fallback caso o fetch ao GitHub falhe/trave
const FALLBACK_WA_VERSION = [2, 3000, 1023052813];

async function getWAVersion() {
  try {
    console.log('WA: buscando versão...');
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    console.log('WA: versão obtida', result.version);
    return result.version;
  } catch (e) {
    console.log('WA: fallback de versão -', e.message);
    return FALLBACK_WA_VERSION;
  }
}

export async function connectWhatsApp(onMessage, db, onAdminMessage = null) {
  if (sock) return;
  onMessageHandler = onMessage;
  dbRef = db;
  manualDisconnect = false;
  setStatus('connecting');
  currentQR = null;

  let saveCreds;
  try {
    console.log('WA: carregando auth...');
    const auth = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = auth.saveCreds;
    const version = await getWAVersion();

    console.log('WA: criando socket...');
    sock = makeWASocket({
      version,
      auth: auth.state,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: { level: 'silent', child: () => ({ level: 'silent', trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child: () => this }) , trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} },
    });
  } catch (e) {
    setStatus('disconnected');
    console.error('WA connect error:', e.message);
    return;
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try { currentQR = await qrcode.toDataURL(qr); } catch (e) { currentQR = null; }
      setStatus('qr');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      sock = null;
      currentQR = null;
      connectedPhone = null;
      setStatus('disconnected');

      if (loggedOut) {
        // Sessão invalidada — limpa credenciais para próxima conexão gerar novo QR
        try { await rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
      } else if (!manualDisconnect && onMessageHandler) {
        setTimeout(() => connectWhatsApp(onMessageHandler, dbRef).catch(err => console.error('WA reconnect failed:', err.message)), 3000);
      }
    } else if (connection === 'open') {
      currentQR = null;
      connectedPhone = sock.user?.id?.split('@')[0]?.split(':')[0] || null;
      setStatus('connected');
      console.log('WA conectado:', connectedPhone);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const selfJid = sock.user?.id
      ? sock.user.id.split(':')[0] + '@s.whatsapp.net'
      : null;
    const isNotify = type === 'notify';

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@broadcast') || jid === 'status@broadcast') continue;

      // Grupo de comandos admin (aceita notify e append — celular manda como append)
      if (jid.endsWith('@g.us')) {
        const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const hasImage = !!msg.message?.imageMessage;
        const hasAudio = !!msg.message?.audioMessage;
        if (!messageText.trim() && !hasImage && !hasAudio) continue;

        if (groupCaptureCallback) {
          const cb = groupCaptureCallback;
          groupCaptureCallback = null;
          cb(jid);
          continue;
        }

        if (adminGroupJid && jid === adminGroupJid && onAdminMessage) {
          if (sentByBot.has(msg.key.id)) { sentByBot.delete(msg.key.id); continue; }
          try {
            let reply;
            if (hasImage) {
              console.log('WA admin grupo: [imagem]');
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              reply = await onAdminMessage('', buffer, null);
            } else if (hasAudio) {
              console.log('WA admin grupo: [audio]');
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              reply = await onAdminMessage('', null, buffer);
            } else {
              console.log(`WA admin grupo: "${messageText}"`);
              reply = await onAdminMessage(messageText);
            }
            if (reply && sock) {
              const sent = await sock.sendMessage(jid, { text: reply });
              if (sent?.key?.id) sentByBot.add(sent.key.id);
            }
          } catch (e) { console.error('WA group admin error:', e.message); }
        }
        continue;
      }

      // Mensagens de clientes: só processa notify
      if (!isNotify) continue;

      const messageText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!messageText.trim()) continue;

      // Mensagem do próprio usuário para si mesmo = comando admin
      if (msg.key.fromMe && selfJid && jid === selfJid) {
        if (onAdminMessage) {
          try {
            const reply = await onAdminMessage(messageText);
            if (reply && sock) {
              await sock.sendMessage(jid, { text: reply });
            }
          } catch (e) {
            console.error('WA admin error:', e.message);
          }
        }
        continue;
      }

      if (msg.key.fromMe) continue;

      try {
        const text = await onMessageHandler(messageText, jid);
        if (text && sock) {
          await sock.sendMessage(jid, { text });
          console.log('Mensagem enviada para', jid);
        }
      } catch (e) {
        console.error('WA handler error:', e.message);
      }
    }
  });
}

export function getStatus() {
  return { status: connectionStatus, qr: currentQR, phone: connectedPhone };
}

export async function disconnectWhatsApp() {
  manualDisconnect = true;
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  currentQR = null;
  connectedPhone = null;
  setStatus('disconnected');
  try { await rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
}

export { AUTH_DIR };

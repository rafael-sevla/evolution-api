import { jidDecode, proto } from 'baileys';

export function isUsableMessageJid(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /\s/.test(value) ||
    value.indexOf('@') !== value.lastIndexOf('@')
  )
    return false;
  const decoded = jidDecode(value);
  return !!decoded?.user && !!decoded.server && (decoded.device === undefined || Number.isInteger(decoded.device));
}

function messageKey(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function resolveMessageKey(value: unknown, storedValue?: unknown): proto.IMessageKey | undefined {
  const key = messageKey(value);
  if (typeof key?.id !== 'string' || !key.id.trim()) return undefined;
  const stored = messageKey(storedValue);
  const fallback = stored?.id === key.id ? stored : undefined;
  const remoteJid = [key.remoteJid, key.remoteJidAlt, fallback?.remoteJid, fallback?.remoteJidAlt].find(
    isUsableMessageJid,
  );
  if (!remoteJid) return undefined;
  return {
    ...key,
    id: key.id,
    remoteJid,
    fromMe:
      typeof key.fromMe === 'boolean' ? key.fromMe : typeof fallback?.fromMe === 'boolean' ? fallback.fromMe : false,
    participant: typeof key.participant === 'string' ? key.participant : undefined,
  };
}

export function storedMessageContent(
  stored: proto.IWebMessageInfo | undefined,
  full: boolean,
): proto.IMessage | proto.IWebMessageInfo | undefined {
  if (!stored) return undefined;
  if (full) return stored;
  const message = stored.message;
  if (!message || !Object.keys(message).length) return undefined;
  const secret: unknown = message.messageContextInfo?.messageSecret;
  if (typeof secret === 'string') {
    return {
      ...message,
      messageContextInfo: { ...message.messageContextInfo, messageSecret: Buffer.from(secret, 'base64') },
    };
  }
  return message;
}

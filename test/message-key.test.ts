import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { proto } from 'baileys';

import { isUsableMessageJid, resolveMessageKey, storedMessageContent } from '../src/api/integrations/channel/whatsapp/message-key';

test('aceita PN, LID, dispositivos, grupos, status e newsletters', () => {
  for (const jid of ['100@s.whatsapp.net', '100:2@s.whatsapp.net', '200@lid', '200:2@hosted.lid', '100-200@g.us', 'status@broadcast', '300@newsletter']) {
    assert.equal(isUsableMessageJid(jid), true, jid);
  }
});

test('recusa identificador ausente, vazio, sem domínio ou com espaços', () => {
  for (const jid of [undefined, null, '', '100', '@lid', '100@', '100@lid ', '100 @lid', '100@@lid', '100:x@lid', {}]) {
    assert.equal(isUsableMessageJid(jid), false);
  }
});

test('preserva JID válido e metadados de endereçamento LID', () => {
  const key = { id: 'message-a', remoteJid: '200@lid', remoteJidAlt: '100@s.whatsapp.net', addressingMode: 'lid', fromMe: true };
  assert.deepEqual(resolveMessageKey(key), { ...key, participant: undefined });
  assert.equal(key.remoteJid, '200@lid');
});

test('recupera JID alternativo do próprio evento sem trocar registro de outra mensagem', () => {
  const key = resolveMessageKey({ id: 'message-a', remoteJidAlt: '200@lid' });
  assert.equal(key.remoteJid, '200@lid');
  assert.equal(resolveMessageKey({ id: 'message-a' }, { id: 'message-b', remoteJid: '100@s.whatsapp.net' }), undefined);
});

test('recupera autoria e endereço somente de registro correspondente', () => {
  const key = resolveMessageKey({ id: 'message-a' }, { id: 'message-a', remoteJid: '100@s.whatsapp.net', fromMe: true });
  assert.equal(key.remoteJid, '100@s.whatsapp.net');
  assert.equal(key.fromMe, true);
});

test('recusa chave sem id e não cria payload para mensagem ausente ou sem conteúdo', () => {
  assert.equal(resolveMessageKey({ remoteJid: '100@s.whatsapp.net' }), undefined);
  assert.equal(storedMessageContent(undefined, false), undefined);
  assert.equal(storedMessageContent({ key: { id: 'empty' } }, false), undefined);
  assert.equal(storedMessageContent({ message: {} }, false), undefined);
});

test('retorna envelope completo e conteúdo legítimo sem inventar mensagem', () => {
  const stored = { key: { id: 'message-a', remoteJid: '100@s.whatsapp.net' }, message: { conversation: 'test-only' } };
  assert.equal(storedMessageContent(stored, true), stored);
  assert.equal(storedMessageContent(stored, false), stored.message);
});

test('restaura segredo de enquete sem mutar registro ou perder campos', () => {
  const stored = {
    message: { pollCreationMessage: { name: 'test-only' }, messageContextInfo: { messageSecret: 'dGVzdC1vbmx5' } },
  };
  const content = storedMessageContent(stored as unknown as proto.IWebMessageInfo, false) as proto.IMessage;
  assert.deepEqual(content.messageContextInfo.messageSecret, Buffer.from('test-only'));
  assert.equal(content.pollCreationMessage.name, 'test-only');
  assert.equal(stored.message.messageContextInfo.messageSecret, 'dGVzdC1vbmx5');
});

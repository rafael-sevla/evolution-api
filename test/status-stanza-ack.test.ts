import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BinaryNode } from 'baileys';

import {
  buildStatusStanzaAck,
  registerStatusStanzaAck,
} from '../src/api/integrations/channel/whatsapp/status-stanza-ack';

function statusNode(attrs: Record<string, string>): BinaryNode {
  return { tag: 'status', attrs, content: [] };
}

function fakeClient(sendNode: (node: BinaryNode) => Promise<void>) {
  const ws = new EventEmitter();
  return { ws, sendNode, client: { ws, sendNode } as any };
}

test('ack de <status> leva id, destino, classe e tipo, sem código de erro', () => {
  const ack = buildStatusStanzaAck(statusNode({ id: 'AC825362', from: '100@s.whatsapp.net', type: 'media', t: '1' }));
  assert.deepEqual(ack, {
    tag: 'ack',
    attrs: { id: 'AC825362', to: '100@s.whatsapp.net', class: 'status', type: 'media' },
  });
  assert.equal(ack?.attrs.error, undefined);
});

test('ack de <status> preserva participant e recipient quando vierem no stanza', () => {
  const ack = buildStatusStanzaAck(
    statusNode({ id: 'x', from: '100-200@g.us', participant: '300@lid', recipient: '400@lid', type: 'text' }),
  );
  assert.deepEqual(ack?.attrs, {
    id: 'x',
    to: '100-200@g.us',
    class: 'status',
    participant: '300@lid',
    recipient: '400@lid',
    type: 'text',
  });
});

test('não monta ack para stanza sem id ou sem remetente', () => {
  assert.equal(buildStatusStanzaAck(undefined), undefined);
  assert.equal(buildStatusStanzaAck(statusNode({ from: '100@s.whatsapp.net' })), undefined);
  assert.equal(buildStatusStanzaAck(statusNode({ id: 'x' })), undefined);
});

test('confirma cada <status> recebido pelo socket, inclusive os reentregues offline', async () => {
  const sent: BinaryNode[] = [];
  const { ws, client } = fakeClient(async (node) => {
    sent.push(node);
  });
  registerStatusStanzaAck(client, () => assert.fail('não deveria falhar'));

  ws.emit('CB:status', statusNode({ id: 'a', from: '100@s.whatsapp.net', type: 'media' }));
  ws.emit('CB:status', statusNode({ id: 'b', from: '200@lid', type: 'text', offline: '0' }));
  ws.emit('CB:status', statusNode({ from: '300@lid' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    sent.map((node) => [node.tag, node.attrs.id, node.attrs.class]),
    [
      ['ack', 'a', 'status'],
      ['ack', 'b', 'status'],
    ],
  );
});

test('falha ao enviar o ack vai para o callback, sem derrubar o socket', async () => {
  const errors: unknown[] = [];
  const { ws, client } = fakeClient(async () => {
    throw new Error('socket fechado');
  });
  registerStatusStanzaAck(client, (error) => errors.push(error));

  ws.emit('CB:status', statusNode({ id: 'a', from: '100@s.whatsapp.net' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /socket fechado/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileFunction } from 'node:vm';
import { isJidBroadcast, isJidGroup, isJidNewsletter } from 'baileys';
import ts from 'typescript';

import { isUsableMessageJid, resolveMessageKey, storedMessageContent } from '../src/api/integrations/channel/whatsapp/message-key';

interface StoredMessage {
  id: string;
  key: { id: string; remoteJid?: string; fromMe?: boolean };
  message: { conversation: string };
  status: string;
}
interface FixtureService {
  instanceId: string;
  instance: { id: string };
  configService: { get: () => unknown };
  prismaRepository: Record<string, unknown>;
  baileysCache: { get: (key?: string) => Promise<unknown>; set: () => Promise<void> };
  logger: { verbose: () => void; warn: (data: unknown) => void; error: (data: unknown) => void; info: () => void };
  sendDataWebhook: () => void;
  messageHandle: {
    'messages.update': (updates: unknown[], settings: object) => Promise<void>;
    'messages.upsert': (payload: { messages: unknown[]; type: string }, settings: object) => Promise<void>;
  };
  getMessage: (key: { id: string; remoteJid?: string }, full?: boolean) => Promise<unknown>;
}

// Execute the actual methods/property initializers without starting the server, sockets or providers.
const filename = join(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
const serviceClass = source.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BaileysStartupService',
)!;
const members = serviceClass.members.filter((member) => ['messageHandle', 'getMessage'].includes(member.name?.getText(source)));
const testClass = ts.factory.createClassDeclaration(undefined, 'Service', undefined, undefined, members);
const code = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, testClass, source), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(records: StoredMessage[] = []) {
  const writes: Record<string, unknown>[] = [];
  const queries: { sql: string; values: unknown[] }[] = [];
  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  const Constructor = compileFunction(`${code};return Service`, [
    'resolveMessageKey', 'storedMessageContent', 'isUsableMessageJid', 'status', 'Events',
  ])(resolveMessageKey, storedMessageContent, isUsableMessageJid, { 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ' }, { MESSAGES_UPDATE: 'messages.update' }) as new () => FixtureService;
  const service = new Constructor();
  service.instanceId = 'instance-a';
  service.instance = { id: 'instance-a' };
  service.configService = { get: () => ({ SAVE_DATA: { HISTORIC: true, NEW_MESSAGE: true, MESSAGE_UPDATE: true } }) };
  service.logger = { verbose() {}, warn: (value) => warnings.push(value), error: (value) => errors.push(value), info() {} };
  service.baileysCache = { get: async () => null, set: async () => {} };
  service.sendDataWebhook = () => {};
  service.prismaRepository = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: strings.join('?'), values });
      return records.filter((record) => values.includes(record.key.id));
    },
    message: { update: async () => {} },
    messageUpdate: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.ok(isUsableMessageJid(data.remoteJid), 'cannot persist missing remoteJid');
        writes.push(data);
      },
    },
    chat: { findFirst: async () => null },
  };
  return { service, writes, queries, warnings, errors };
}

test('lookup ausente retorna undefined, sem inventar conversa vazia para retry', async () => {
  const { service } = fixture();
  assert.equal(await service.getMessage({ id: 'missing', remoteJid: '100@s.whatsapp.net' }), undefined);
});

test('erro de lookup não inventa payload nem inclui exceção/credenciais no log', async () => {
  const { service, warnings } = fixture();
  service.prismaRepository.$queryRaw = async () => { throw new Error('sensitive-test-only'); };
  assert.equal(await service.getMessage({ id: 'missing', remoteJid: '100@s.whatsapp.net' }), undefined);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes('sensitive-test-only'));
});

test('upserts inválidos e stubs de decrypt não abortam o lote nem expõem conteúdo', async () => {
  const { service, warnings, errors } = fixture();
  await service.messageHandle['messages.upsert']({
    type: 'notify',
    messages: [
      { key: { id: 'missing' }, message: { conversation: 'sensitive-test-only' } },
      { key: { id: 'stub', remoteJid: '100@s.whatsapp.net' }, messageStubParameters: ['Bad MAC'], message: { conversation: 'sensitive-test-only' } },
    ],
  }, {});
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 2);
  assert.ok(!JSON.stringify(warnings).includes('sensitive-test-only'));
});

test('recupera remoteJid de mensagem da mesma instância antes de persistir atualização', async () => {
  const { service, writes, queries } = fixture([{
    id: 'stored-a', key: { id: 'message-a', remoteJid: '100@s.whatsapp.net', fromMe: true },
    message: { conversation: 'test-only' }, status: 'SERVER_ACK',
  }]);
  await service.messageHandle['messages.update']([{ key: { id: 'message-a', fromMe: true }, update: { status: 3 } }], {});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].remoteJid, '100@s.whatsapp.net');
  assert.ok(queries.every((query) => query.values.includes('instance-a')));
});

test('evento incompleto sem registro não impede atualização válida posterior no lote', async () => {
  const { service, writes } = fixture([{
    id: 'stored-b', key: { id: 'message-b', remoteJid: '200@lid', fromMe: true },
    message: { conversation: 'test-only' }, status: 'SERVER_ACK',
  }]);
  await service.messageHandle['messages.update']([
    { key: { id: 'missing', fromMe: true }, update: { status: 3 } },
    { key: { id: 'message-b', remoteJid: '200@lid', fromMe: true }, update: { status: 3 } },
  ], {});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].remoteJid, '200@lid');
});

test('não escolhe uma conversa arbitrária quando o id está ambíguo', async () => {
  const { service, writes } = fixture(['100@s.whatsapp.net', '200@lid'].map((remoteJid, index) => ({
    id: `stored-${index}`, key: { id: 'duplicate', remoteJid, fromMe: true },
    message: { conversation: 'test-only' }, status: 'SERVER_ACK',
  })));
  await service.messageHandle['messages.update']([{ key: { id: 'duplicate', fromMe: true }, update: { status: 3 } }], {});
  assert.equal(writes.length, 0);
});

test('recuperação de conversa preserva referência à mensagem original em atualizações de protocolo', async () => {
  const { service, writes } = fixture(['protocol-event', 'original-message'].map((id) => ({
    id: `${id}-row`, key: { id, remoteJid: '100@s.whatsapp.net', fromMe: true },
    message: { conversation: 'test-only' }, status: 'SERVER_ACK',
  })));
  service.baileysCache.get = async (key) => key === 'protocol_protocol-event' ? 'original-message' : null;
  await service.messageHandle['messages.update']([{ key: { id: 'protocol-event', fromMe: true }, update: { status: 3 } }], {});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].messageId, 'original-message-row');
  assert.equal(writes[0].keyId, 'original-message');
});

test('socket ignora recibo sem JID antes de acionar resends e recriação de sessão', () => {
  let ignore: ts.ArrowFunction | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'shouldIgnoreJid') ignore = node.initializer as ts.ArrowFunction;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(ignore);
  const expression = ts.transpileModule(`const ignore = ${ignore.getText(source)};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { localSettings: { groupsIgnore: false, readStatus: true, syncFullHistory: false } };
  const shouldIgnore = compileFunction(`${expression};return ignore;`, [
    'isUsableMessageJid', 'isJidGroup', 'isJidBroadcast', 'isJidNewsletter',
  ]).call(context, isUsableMessageJid, isJidGroup, isJidBroadcast, isJidNewsletter) as (value: unknown) => boolean;
  assert.equal(shouldIgnore.call(context, undefined), true);
  assert.equal(shouldIgnore.call(context, 'not-a-jid'), true);
  assert.equal(shouldIgnore.call(context, '100@s.whatsapp.net'), false);
  assert.equal(shouldIgnore.call(context, '200@lid'), false);
});

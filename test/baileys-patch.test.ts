import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileFunction } from 'node:vm';

import { BAILEYS_VERSION, PATCHES, baileysDir, patchSource } from '../scripts/patch-baileys.mjs';

const MESSAGES_RECV = 'lib/Socket/messages-recv.js';
const PROCESS_MESSAGE = 'lib/Utils/process-message.js';
const installed = (file: string) => readFileSync(join(baileysDir(), file), 'utf8');

function unpatch(file: string, source: string): string {
  let out = source;
  for (const patch of [...PATCHES[file]].reverse()) out = out.split(patch.after).join(patch.before);
  return out;
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `trecho não encontrado: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to >= 0, `fim não encontrado: ${end}`);
  return source.slice(from, to + end.length);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('o Baileys instalado é a versão do patch e o postinstall já aplicou todas as trocas', () => {
  const { version } = JSON.parse(installed('package.json'));
  assert.equal(version, BAILEYS_VERSION);
  for (const file of Object.keys(PATCHES)) {
    const source = installed(file);
    for (const patch of PATCHES[file]) {
      assert.equal(source.split(patch.after).length - 1, patch.count, `${file}: ${patch.name}`);
    }
    assert.equal(patchSource(file, source), source, `${file}: aplicar de novo não pode mudar nada`);
  }
});

test('o patch parte do código original do rc.9 e chega exatamente no instalado', () => {
  for (const file of Object.keys(PATCHES)) {
    const source = installed(file);
    const original = unpatch(file, source);
    assert.notEqual(original, source);
    assert.equal(patchSource(file, original), source);
  }
});

test('o patch falha alto quando o trecho original não existe (outra versão do Baileys)', () => {
  assert.throws(() => patchSource(MESSAGES_RECV, 'código de outra versão'), /Revise o patch/);
  assert.throws(() => patchSource(PROCESS_MESSAGE, ''), /Revise o patch/);
});

function offlineProcessor(source: string) {
  const body = sliceBetween(source, '    const makeOfflineNodeProcessor = () => {', '        return { enqueue };\n    };');
  const make = compileFunction(`${body}\nreturn makeOfflineNodeProcessor();`, [
    'handleMessage',
    'handleCall',
    'handleReceipt',
    'handleNotification',
    'ws',
    'onUnexpectedError',
  ]);
  const processed: string[] = [];
  const errors: string[] = [];
  const handler = (fail?: string, error?: Error) => async (node: { id: string }) => {
    processed.push(node.id);
    if (node.id === fail) throw error;
  };
  const processor = make(
    handler('sem-tipo', new Error('Unknown message type')),
    handler(),
    handler(),
    handler('grupo', new SyntaxError('Unexpected non-whitespace character after JSON')),
    { isOpen: true },
    (error: Error, where: string) => errors.push(`${where}: ${error.message}`),
  ) as { enqueue: (type: string, node: { id: string }) => void };
  return { processor, processed, errors };
}

test('sem o patch, o rc.9 trava a fila offline no primeiro nó que lança (o bug de produção)', async () => {
  const { processor, processed } = offlineProcessor(unpatch(MESSAGES_RECV, installed(MESSAGES_RECV)));
  processor.enqueue('message', { id: 'sem-tipo' });
  processor.enqueue('call', { id: 'chamada' });
  for (let i = 0; i < 10; i++) await tick();
  processor.enqueue('receipt', { id: 'recibo' });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(processed, ['sem-tipo']);
});

test('fila offline: um nó que lança não impede os seguintes de serem processados', async () => {
  const { processor, processed, errors } = offlineProcessor(installed(MESSAGES_RECV));

  processor.enqueue('message', { id: 'sem-tipo' });
  processor.enqueue('notification', { id: 'grupo' });
  processor.enqueue('call', { id: 'chamada' });
  processor.enqueue('receipt', { id: 'recibo' });
  for (let i = 0; i < 10; i++) await tick();

  assert.deepEqual(processed, ['sem-tipo', 'grupo', 'chamada', 'recibo']);
  assert.deepEqual(errors, [
    'processing offline message: Unknown message type',
    'processing offline notification: Unexpected non-whitespace character after JSON',
  ]);

  processor.enqueue('message', { id: 'depois' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(processed.at(-1), 'depois', 'a fila continua aceitando nós depois das falhas');
});

test('mensagem que não decodifica recebe NACK antes de sair, sem lançar', () => {
  const source = installed(MESSAGES_RECV);
  const handleMessage = sliceBetween(source, '    const handleMessage = async (node) => {', 'const alt = ');
  assert.doesNotMatch(handleMessage, /= decryptMessageNode\(node[^\n]*\n\s*const alt/);
  assert.match(
    handleMessage,
    /try \{\s*decodedNode = decryptMessageNode\(node,[^\n]*\n\s*\}\s*catch \(error\) \{[\s\S]*?await sendMessageAck\(node, NACK_REASONS\.UnhandledError\);\s*return;\s*\}/,
  );
});

test('parâmetro de participante em JID puro vira { id } em vez de lançar', () => {
  const source = installed(PROCESS_MESSAGE);
  assert.equal(source.includes('JSON.parse(a)'), false);
  const helper = sliceBetween(source, 'function __forkParseStubParticipant(value) {', '        return { id: value };\n    }\n}');
  const parse = compileFunction(`${helper}\nreturn __forkParseStubParticipant;`)() as (value: string) => unknown;

  assert.deepEqual(parse('{"id":"100@lid","phoneNumber":"55@s.whatsapp.net"}'), {
    id: '100@lid',
    phoneNumber: '55@s.whatsapp.net',
  });
  assert.deepEqual(parse('146935377875107@lid'), { id: '146935377875107@lid' });
  assert.deepEqual(parse('553899267970@s.whatsapp.net'), { id: '553899267970@s.whatsapp.net' });
});

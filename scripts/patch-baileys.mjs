#!/usr/bin/env node
/*
 * Correções locais no Baileys 7.0.0-rc.9, aplicadas no postinstall (o Dockerfile copia este arquivo
 * antes do `npm ci`). Cada troca exige o trecho original exato, e rodar de novo não muda nada.
 * Se a versão do Baileys mudar, o script falha de propósito: revisar e remover o que a nova versão
 * já corrigir.
 *
 * Contexto: em produção, uma exceção em um único nó da fila offline (mensagem que não decodifica ou
 * evento de grupo com parâmetro fora do formato JSON) matava a fila. Os nós seguintes ficavam sem ack,
 * o servidor derrubava o stream ~50 min depois e reentregava os mesmos nós na reconexão, em loop.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BAILEYS_VERSION = '7.0.0-rc.9';
export const MARK = '/* evolution-fork-patch */';

const PARSE_HELPER = `
${MARK}
// Parâmetros de stub de participante às vezes chegam como JID puro (ex.: "146935377875107@lid"),
// não como JSON. JSON.parse lançava e derrubava a fila offline.
function __forkParseStubParticipant(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return { id: value };
    }
}
`;

export const PATCHES = {
  'lib/Socket/messages-recv.js': [
    {
      name: 'fila offline captura erro por nó (como no rc14)',
      count: 1,
      before: '                    await nodeProcessor(node);\n',
      after: `                    await nodeProcessor(node).catch(error => onUnexpectedError(error, \`processing offline \${type}\`)); ${MARK}\n`,
    },
    {
      name: 'mensagem que não decodifica recebe NACK em vez de lançar sem ack',
      count: 1,
      before:
        "        const { fullMessage: msg, category, author, decrypt } = decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, logger);\n",
      after: [
        `        let decodedNode; ${MARK}`,
        '        try {',
        "            decodedNode = decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, logger);",
        '        }',
        '        catch (error) {',
        '            // Ex.: "Unknown message type". O NACK é o mesmo que o Baileys usa para mensagens ignoradas.',
        "            logger.warn({ error, attrs: node.attrs }, 'failed to decode message node, sending nack');",
        '            await sendMessageAck(node, NACK_REASONS.UnhandledError);',
        '            return;',
        '        }',
        '        const { fullMessage: msg, category, author, decrypt } = decodedNode;',
        '',
      ].join('\n'),
    },
  ],
  'lib/Utils/process-message.js': [
    {
      name: 'parâmetros de participante aceitam JID puro',
      count: 5,
      before: '.map((a) => JSON.parse(a))',
      after: '.map((a) => __forkParseStubParticipant(a))',
    },
    {
      name: 'helper de parse tolerante',
      count: 1,
      before: '\n//# sourceMappingURL=process-message.js.map',
      after: `${PARSE_HELPER}//# sourceMappingURL=process-message.js.map`,
    },
  ],
};

function occurrences(source, text) {
  return source.split(text).length - 1;
}

/** Aplica as trocas de um arquivo. Devolve o novo conteúdo; lança se o original não bater. */
export function patchSource(file, source) {
  let out = source;
  for (const patch of PATCHES[file]) {
    const applied = occurrences(out, patch.after);
    if (applied === patch.count) continue;
    const found = occurrences(out, patch.before);
    if (applied !== 0 || found !== patch.count) {
      throw new Error(
        `[patch-baileys] ${file}: "${patch.name}" esperava ${patch.count} ocorrência(s) do trecho original, ` +
          `achou ${found} (já aplicadas: ${applied}). Revise o patch para esta versão do Baileys.`,
      );
    }
    out = out.split(patch.before).join(patch.after);
  }
  return out;
}

export function baileysDir(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  return join(root, 'node_modules', 'baileys');
}

export function applyBaileysPatches(dir = baileysDir()) {
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (version !== BAILEYS_VERSION) {
    throw new Error(
      `[patch-baileys] Baileys ${version} instalado, patch feito para ${BAILEYS_VERSION}. ` +
        'Revise scripts/patch-baileys.mjs e remova o que a nova versão já corrigir.',
    );
  }
  const changed = [];
  for (const file of Object.keys(PATCHES)) {
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    const patched = patchSource(file, source);
    if (patched !== source) {
      writeFileSync(path, patched);
      changed.push(file);
    }
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = applyBaileysPatches();
  console.log(changed.length ? `[patch-baileys] aplicado em: ${changed.join(', ')}` : '[patch-baileys] já aplicado');
}

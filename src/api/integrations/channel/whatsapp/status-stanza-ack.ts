import type { BinaryNode, WASocket } from 'baileys';

/*
 * O WhatsApp passou a entregar o Status de alguns contatos como um stanza <status> de primeiro nível,
 * em vez de <message from="status@broadcast">. O Baileys 7.0.0-rc.9 não registra handler para ele,
 * então o stanza nunca recebe ack. Cerca de 50 min depois o servidor derruba o stream com
 * stream:error <ack class="status"> (mapeado para badSession), reentrega o mesmo status na
 * reconexão e o ciclo se repete. Ver WhiskeySockets/Baileys#2858.
 *
 * O ack é simples, sem código de erro (um NACK mantém o stanza pendente no servidor), e espelha os
 * atributos que o sendMessageAck do Baileys usa para tags diferentes de "message".
 * Remover quando o Baileys publicar a correção.
 */
export function buildStatusStanzaAck(node: BinaryNode | undefined): BinaryNode | undefined {
  const attrs = node?.attrs;
  if (!attrs?.id || !attrs.from) return undefined;

  const ack: BinaryNode = { tag: 'ack', attrs: { id: attrs.id, to: attrs.from, class: 'status' } };
  if (attrs.participant) ack.attrs.participant = attrs.participant;
  if (attrs.recipient) ack.attrs.recipient = attrs.recipient;
  if (attrs.type) ack.attrs.type = attrs.type;
  return ack;
}

export function registerStatusStanzaAck(
  client: Pick<WASocket, 'ws' | 'sendNode'>,
  onError: (error: unknown) => void,
): void {
  client.ws.on('CB:status', (node: BinaryNode) => {
    const ack = buildStatusStanzaAck(node);
    if (!ack) return;
    client.sendNode(ack).catch(onError);
  });
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeInstanceSession } from '../src/api/services/remove-instance-session';

test('socket morto não impede a remoção e a resposta aguarda a persistência', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const deletion = removeInstanceSession({
    logout: async () => { calls.push('logout'); throw new Error('Connection Closed'); },
    onLogoutError: () => { calls.push('warning'); },
    remove: async () => { calls.push('remove'); await new Promise<void>((resolve) => { finish = resolve; }); calls.push('removed'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['logout', 'warning', 'remove']);
  finish();
  await deletion;
  assert.deepEqual(calls, ['logout', 'warning', 'remove', 'removed']);
});

test('erro ao remover o cadastro não é tratado como sucesso', async () => {
  await assert.rejects(removeInstanceSession({ logout: async () => {}, onLogoutError: () => {}, remove: async () => { throw new Error('database unavailable'); } }), /database unavailable/);
});

test('sessão saudável é desconectada antes da exclusão', async () => {
  const calls: string[] = [];
  await removeInstanceSession({ logout: async () => { calls.push('logout'); }, onLogoutError: () => { assert.fail('não deve falhar'); }, remove: async () => { calls.push('remove'); } });
  assert.deepEqual(calls, ['logout', 'remove']);
});

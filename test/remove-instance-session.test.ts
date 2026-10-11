import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchInstanceLifecycleEvent, removeInstanceSession } from '../src/api/services/remove-instance-session';

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

test('logout pendente tem prazo, mas a resposta continua aguardando a persistência', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  let acknowledged = false;
  const deletion = removeInstanceSession({
    logout: () => new Promise(() => {}),
    logoutTimeoutMs: 5,
    onLogoutError: () => { calls.push('timeout'); },
    remove: async () => {
      calls.push('remove');
      await new Promise<void>((resolve) => { finish = resolve; });
    },
  }).then(() => { acknowledged = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, ['timeout', 'remove']);
  assert.equal(acknowledged, false);
  finish();
  await deletion;
  assert.equal(acknowledged, true);
});

test('prazo de logout não transforma falha de persistência em sucesso', async () => {
  const deletion = removeInstanceSession({
    logout: () => new Promise(() => {}),
    logoutTimeoutMs: 5,
    onLogoutError: () => {},
    remove: async () => { throw new Error('database unavailable'); },
  });
  const result = await Promise.race([
    deletion.then(() => 'success', (error: Error) => error.message),
    new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 40)),
  ]);
  assert.equal(result, 'database unavailable');
});

test('rejeição tardia do logout é observada depois de vencer o prazo', async () => {
  let rejectLogout!: (error: Error) => void;
  await removeInstanceSession({
    logout: () => new Promise((_, reject) => { rejectLogout = reject; }),
    logoutTimeoutMs: 5,
    onLogoutError: () => {},
    remove: async () => {},
  });
  rejectLogout(new Error('late connection error'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('eventos lifecycle observam falhas síncronas e assíncronas sem propagá-las', async () => {
  const errors: unknown[] = [];
  dispatchInstanceLifecycleEvent(() => { throw new Error('sync webhook error'); }, (error) => errors.push(error));
  dispatchInstanceLifecycleEvent(async () => { throw new Error('async webhook error'); }, (error) => errors.push(error));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors.map((error) => (error as Error).message), ['sync webhook error', 'async webhook error']);
});

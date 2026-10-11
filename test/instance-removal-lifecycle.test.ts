import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

interface Monitor {
  waInstances: Record<string, { sendDataWebhook: () => Promise<void>; stopForRemoval?: () => void }>;
  cleaningUp: (name: string) => Promise<void>;
  cleaningStoreData: (name: string) => Promise<void>;
  removeInstanceNow: (name: string) => Promise<void>;
}

async function settlesQuickly(operation: Promise<unknown>) {
  return Promise.race([
    operation.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 40)),
  ]);
}

/** Load actual source with server bootstrap and external I/O isolated. */
function loadSource(relativePath: string, mocks: Record<string, unknown>, fallback?: (name: string) => unknown) {
  const filename = join(__dirname, '../src', relativePath);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  compileFunction(source, ['require', 'module', 'exports'], { filename })(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : fallback ? fallback(name) : require(name), module, module.exports,
  );
  return module.exports;
}

function fixture() {
  const handlers = new Map<string, (name: string) => Promise<void>>();
  const emitter = { on: (event: string, handler: (name: string) => Promise<void>) => handlers.set(event, handler) };
  class Logger {
    error() {}
    warn() {}
  }
  const mocks: Record<string, unknown> = {
    '@api/server.module': {},
    '@api/types/wa.types': { Events: { REMOVE_INSTANCE: 'remove', LOGOUT_INSTANCE: 'logout' } },
    '@config/logger.config': { Logger },
    '@config/path.config': {},
    '@exceptions': {},
    './remove-instance-session': loadSource('api/services/remove-instance-session.ts', {}),
  };
  const Constructor = loadSource('api/services/monitor.service.ts', mocks).WAMonitoringService as new (...args: unknown[]) => Monitor;
  const config = { get: (name: string) => ({ DATABASE: { SAVE_DATA: { INSTANCE: false } }, CACHE: { REDIS: { ENABLED: false } }, PROVIDER: { ENABLED: false }, CHATWOOT: { ENABLED: false } })[name] };
  const monitor = new Constructor(emitter, config, {}, {}, {}, {}, {});
  monitor.waInstances.target = { sendDataWebhook: async () => {} };
  monitor.waInstances.other = { sendDataWebhook: async () => {} };
  return { monitor, handlers };
}

test('exclusão aguarda logout em andamento, deduplica chamadas e preserva outras instâncias', async () => {
  const { monitor, handlers } = fixture();
  let finish!: () => void;
  let cleanups = 0;
  let stores = 0;
  monitor.cleaningUp = async () => {
    cleanups++;
    if (cleanups === 1) await new Promise<void>((resolve) => { finish = resolve; });
  };
  monitor.cleaningStoreData = async () => { stores++; };
  const logout = handlers.get('logout.instance')!('target');
  await new Promise((resolve) => setImmediate(resolve));
  const first = monitor.removeInstanceNow('target');
  const second = monitor.removeInstanceNow('target');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stores, 0);
  finish();
  await Promise.all([logout, first, second]);
  assert.equal(stores, 1);
  assert.equal(cleanups, 2);
  assert.equal(monitor.waInstances.target, undefined);
  assert.ok(monitor.waInstances.other);
});

test('falha de persistência é propagada e permite uma nova tentativa', async () => {
  const { monitor } = fixture();
  monitor.cleaningUp = async () => {};
  monitor.cleaningStoreData = async () => { throw new Error('database unavailable'); };
  await assert.rejects(monitor.removeInstanceNow('target'), /database unavailable/);
  assert.ok(monitor.waInstances.target);
  monitor.cleaningStoreData = async () => {};
  await monitor.removeInstanceNow('target');
  assert.equal(monitor.waInstances.target, undefined);
});

test('remove cadastro sem socket em memória e não depende do webhook', async () => {
  const { monitor } = fixture();
  const removed: string[] = [];
  monitor.waInstances.target.sendDataWebhook = async () => { throw new Error('webhook unavailable'); };
  monitor.cleaningUp = async () => {};
  monitor.cleaningStoreData = async (name) => { removed.push(name); };
  await monitor.removeInstanceNow('target');
  await monitor.removeInstanceNow('persisted-only');
  assert.deepEqual(removed, ['target', 'persisted-only']);
  assert.ok(monitor.waInstances.other);
});

test('guard permite excluir cadastro persistido mesmo sem memória ou cache Redis', async () => {
  let nextCalled = false;
  const guard = loadSource('api/guards/instance.guard.ts', {
    '@api/server.module': { waMonitor: { waInstances: {} }, cache: { has: async () => false }, prismaRepository: { instance: { findMany: async () => [{ name: 'target' }] } } },
    '@config/env.config': { configService: { get: () => ({ REDIS: { ENABLED: true, SAVE_INSTANCES: true } }) } },
    '@exceptions': { InternalServerErrorException: Error, NotFoundException: Error, BadRequestException: Error },
  }).instanceExistsGuard as (req: unknown, res: unknown, next: () => void) => Promise<void>;
  await guard({ originalUrl: '/instance/delete/target', params: { instanceName: 'target' } }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('webhook pendente não bloqueia a persistência nem o fechamento do socket', async () => {
  const { monitor } = fixture();
  const calls: string[] = [];
  monitor.waInstances.target.sendDataWebhook = () => new Promise(() => {});
  monitor.waInstances.target.stopForRemoval = () => { calls.push('stop'); };
  monitor.cleaningUp = async () => { calls.push('cleanup'); };
  monitor.cleaningStoreData = async () => { calls.push('persist'); };
  assert.equal(await settlesQuickly(monitor.removeInstanceNow('target')), true);
  assert.deepEqual(calls, ['stop', 'cleanup', 'persist']);
  assert.equal(monitor.waInstances.target, undefined);
  assert.ok(monitor.waInstances.other);
});

test('webhook de logout pendente não bloqueia uma exclusão posterior', async () => {
  const { monitor, handlers } = fixture();
  const calls: string[] = [];
  monitor.waInstances.target.sendDataWebhook = () => new Promise(() => {});
  monitor.cleaningUp = async () => { calls.push('cleanup'); };
  monitor.cleaningStoreData = async () => { calls.push('persist'); };
  const logout = handlers.get('logout.instance')!('target');
  assert.equal(await settlesQuickly(logout), true);
  assert.equal(await settlesQuickly(monitor.removeInstanceNow('target')), true);
  assert.deepEqual(calls, ['cleanup', 'cleanup', 'persist']);
});

test('controller não aguarda entrega de INSTANCE_DELETE antes de persistir', async () => {
  const calls: string[] = [];
  class Logger { warn() {} error() {} }
  const helper = loadSource('api/services/remove-instance-session.ts', {});
  const Constructor = loadSource('api/controllers/instance.controller.ts', {
    '@api/server.module': {},
    '@api/services/remove-instance-session': helper,
    '@api/types/wa.types': { Events: { INSTANCE_DELETE: 'instance.delete' } },
    '@config/logger.config': { Logger },
    '@exceptions': { InternalServerErrorException: Error },
    baileys: {},
  }).InstanceController as new (...args: unknown[]) => {
    deleteInstance: (data: { instanceName: string }) => Promise<{ status: string }>;
  };
  const monitor = {
    waInstances: {
      target: {
        logoutInstance: async () => { calls.push('logout'); },
        sendDataWebhook: () => new Promise(() => {}),
      },
    },
    removeInstanceNow: async () => { calls.push('persist'); },
  };
  const config = { get: () => ({ ENABLED: false }) };
  const controller = new Constructor(monitor, config);
  assert.equal(await settlesQuickly(controller.deleteInstance({ instanceName: 'target' })), true);
  assert.deepEqual(calls, ['logout', 'persist']);
  monitor.removeInstanceNow = async () => { throw new Error('database unavailable'); };
  await assert.rejects(controller.deleteInstance({ instanceName: 'target' }), /database unavailable/);
});

test('Baileys encerra o socket sem permitir reconexão durante a remoção', async () => {
  class CacheEngine { getEngine() {} }
  const Constructor = loadSource('api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', {
    '@api/services/channel.service': { ChannelStartupService: class {} },
    '@api/services/cache.service': { CacheService: class {} },
    '@cache/cacheengine': { CacheEngine },
    '@config/env.config': { configService: {} },
  }, () => ({})).BaileysStartupService as { prototype: object };
  const service = Object.create(Constructor.prototype) as {
    removing: boolean;
    endSession: boolean;
    messageProcessor: { onDestroy: () => void };
    client: { end: (error: undefined) => void };
    stopForRemoval: () => void;
    connectionUpdate: (update: { connection: string }) => Promise<void>;
    createClient: () => Promise<unknown>;
  };
  const calls: string[] = [];
  service.removing = false;
  service.endSession = false;
  service.messageProcessor = { onDestroy: () => { calls.push('destroy'); } };
  service.client = { end: () => {
    assert.equal(service.removing, true);
    assert.equal(service.endSession, true);
    calls.push('end');
  } };
  service.stopForRemoval();
  await service.connectionUpdate({ connection: 'close' });
  assert.equal(await service.createClient(), undefined);
  assert.deepEqual(calls, ['destroy', 'end']);
});

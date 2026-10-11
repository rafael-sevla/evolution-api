import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

interface Monitor {
  waInstances: Record<string, { sendDataWebhook: () => Promise<void> }>;
  cleaningUp: (name: string) => Promise<void>;
  cleaningStoreData: (name: string) => Promise<void>;
  removeInstanceNow: (name: string) => Promise<void>;
}

/** Load actual source with server bootstrap and external I/O isolated. */
function loadSource(relativePath: string, mocks: Record<string, unknown>) {
  const filename = join(__dirname, '../src', relativePath);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  compileFunction(source, ['require', 'module', 'exports'], { filename })(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports,
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

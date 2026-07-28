import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, getFriction, searchCatalog, updateFriction } from '../.github/extensions/grease/core/catalog.mjs';
import { classifySessionEvent } from '../.github/extensions/grease/core/classifier.mjs';

async function capture(root, at) {
  const [signal] = classifySessionEvent('tool.execution_complete', {
    success: false,
    toolName: 'alpha.run',
    error: 'Access denied',
  });
  const event = { ...signal, at };
  delete event.id;
  await appendEvent(event, { root });
}

test('a resolved item returns to open when the same friction recurs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-reopen-'));
  try {
    await capture(root, '2026-07-01T00:00:00.000Z');

    const { items } = await searchCatalog({}, { root });
    await updateFriction(items[0].id, { status: 'resolved' }, { root, now: '2026-07-02T00:00:00.000Z' });

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'resolved');

    await capture(root, '2026-07-03T00:00:00.000Z');

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'open', 'a recurrence after closure must reopen the item');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an ignored item returns to open when the same friction recurs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-reopen-'));
  try {
    await capture(root, '2026-07-01T00:00:00.000Z');

    const { items } = await searchCatalog({}, { root });
    await updateFriction(items[0].id, { status: 'ignored' }, { root, now: '2026-07-02T00:00:00.000Z' });

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'ignored');

    await capture(root, '2026-07-03T00:00:00.000Z');

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'open', 'a recurrence after ignoring must reopen the item');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a recurrence before the closing update leaves the item closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-reopen-'));
  try {
    await capture(root, '2026-07-01T00:00:00.000Z');
    await capture(root, '2026-07-02T00:00:00.000Z');

    const { items } = await searchCatalog({}, { root });
    await updateFriction(items[0].id, { status: 'resolved' }, { root, now: '2026-07-03T00:00:00.000Z' });

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'resolved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a triaged item is not reopened by recurrence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-reopen-'));
  try {
    await capture(root, '2026-07-01T00:00:00.000Z');

    const { items } = await searchCatalog({}, { root });
    await updateFriction(items[0].id, { status: 'triaged' }, { root, now: '2026-07-02T00:00:00.000Z' });

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'triaged');

    await capture(root, '2026-07-03T00:00:00.000Z');

    assert.equal((await getFriction(items[0].id, { root })).item.status, 'triaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

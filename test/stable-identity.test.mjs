import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, buildCatalog, getFriction, readEvents, searchCatalog } from '../.github/extensions/grease/core/catalog.mjs';
import { classifySessionEvent } from '../.github/extensions/grease/core/classifier.mjs';
import { createGreaseTools } from '../.github/extensions/grease/core/tools.mjs';

async function seed(root, toolName, error) {
  const [signal] = classifySessionEvent('tool.execution_complete', { success: false, toolName, error });
  await appendEvent(signal, { root });
}

test('a captured signal event records its friction id in the log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-identity-'));
  try {
    await seed(root, 'alpha.run', 'Access denied');

    const events = await readEvents({ root });
    const signal = events.find((event) => event.type === 'friction.signal');
    const { items } = await searchCatalog({}, { root });

    assert.equal(typeof signal.frictionId, 'string', 'the captured signal must record its friction id');
    assert.equal(signal.frictionId, items[0].id, 'the recorded id must be the id the catalog uses');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grease_capture returns the item id of the captured item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-identity-'));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const raw = await tools.get('grease_capture').handler({
      title: 'Identity probe',
      summary: 'Capture must report the item id it created or updated',
      severity: 'medium',
      kind: 'tool-failure',
      source: 'test',
      evidence: 'Call grease_capture and inspect the payload'
    }, {});
    const payload = JSON.parse(raw.textResultForLlm);

    assert.equal(typeof payload.data.itemId, 'string', 'grease_capture must return the item id');

    const { items } = await searchCatalog({}, { root });
    assert.equal(payload.data.itemId, items[0].id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an item id recorded on the event wins over a recomputed one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-identity-'));
  try {
    await seed(root, 'beta.run', 'EPERM');

    const events = await readEvents({ root });
    const pinned = events.map((event) => event.type === 'friction.signal' ? { ...event, frictionId: 'pinned-identity-0001' } : event);
    const catalog = buildCatalog(pinned);

    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0].id, 'pinned-identity-0001', 'a recorded id must not be recomputed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an item captured through the tool can be updated with the id it returned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grease-identity-'));
  try {
    const tools = new Map(createGreaseTools({ root }).map((tool) => [tool.name, tool]));
    const payload = JSON.parse((await tools.get('grease_capture').handler({
      title: 'Round trip probe',
      summary: 'Capture then update the same item',
      severity: 'low',
      kind: 'tool-failure',
      source: 'test',
      evidence: 'Capture then update'
    }, {})).textResultForLlm);
    const itemId = payload.data.itemId;

    const rawUpdate = await tools.get('grease_update').handler({ id: itemId, status: 'triaged' }, {});
    const updatePayload = JSON.parse(rawUpdate.textResultForLlm);

    assert.equal(updatePayload.data.notFound, undefined, 'the id returned by capture must resolve');
    assert.equal((await getFriction(itemId, { root })).item.status, 'triaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

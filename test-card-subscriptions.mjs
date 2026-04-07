// test-card-subscriptions.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { UserStore } from './user-store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('card_subscriptions', () => {
  let store, tmp;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'card-sub-'));
    store = new UserStore(join(tmp, 'test.db'));
    store.createPendingUser({ email: 'test@test.com', display_name: 'Test', provider: 'google', provider_id: '1' });
    store.approveUser('test@test.com', 'admin');
  });
  after(() => { store.close(); rmSync(tmp, { recursive: true }); });

  it('getCardState returns subscribed for unknown sessions', () => {
    assert.equal(store.getCardState('test@test.com', 'cp-foo'), 'subscribed');
  });

  it('setCardState creates new row', () => {
    store.setCardState('test@test.com', 'cp-foo', 'paused');
    assert.equal(store.getCardState('test@test.com', 'cp-foo'), 'paused');
  });

  it('setCardState updates existing row', () => {
    store.setCardState('test@test.com', 'cp-foo', 'unsubscribed');
    assert.equal(store.getCardState('test@test.com', 'cp-foo'), 'unsubscribed');
  });

  it('getCardStates returns all rows for user', () => {
    store.setCardState('test@test.com', 'cp-bar', 'paused');
    const states = store.getCardStates('test@test.com');
    assert.equal(states.length, 2);
    assert.equal(states.find(s => s.session_name === 'cp-foo').state, 'unsubscribed');
    assert.equal(states.find(s => s.session_name === 'cp-bar').state, 'paused');
  });

  it('bulkSetCardStates replaces all states', () => {
    store.bulkSetCardStates('test@test.com', [
      { session_name: 'cp-a', state: 'subscribed' },
      { session_name: 'cp-b', state: 'paused' },
    ]);
    const states = store.getCardStates('test@test.com');
    // Old rows for cp-foo, cp-bar should be gone
    assert.equal(states.find(s => s.session_name === 'cp-foo'), undefined);
    assert.equal(states.find(s => s.session_name === 'cp-b').state, 'paused');
  });

  it('deleteCardState removes row', () => {
    store.deleteCardState('test@test.com', 'cp-a');
    assert.equal(store.getCardState('test@test.com', 'cp-a'), 'subscribed'); // default
  });
});

describe('card_preferences', () => {
  let store, tmp;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'card-pref-'));
    store = new UserStore(join(tmp, 'test.db'));
  });
  after(() => { store.close(); rmSync(tmp, { recursive: true }); });

  it('getCardPrefs returns defaults for unknown user', () => {
    const prefs = store.getCardPrefs('nobody@test.com');
    assert.equal(prefs.auto_show_new, 1);
    assert.equal(prefs.auto_show_own, 1);
  });

  it('setCardPrefs creates/updates prefs', () => {
    store.setCardPrefs('test@test.com', { auto_show_new: 0, auto_show_own: 1 });
    const prefs = store.getCardPrefs('test@test.com');
    assert.equal(prefs.auto_show_new, 0);
    assert.equal(prefs.auto_show_own, 1);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

function editor(confirm = true) {
  const elements = new Map();
  const requests = [];
  const confirmations = [];
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.options = []; this.handlers = {}; this.attrs = {}; }
    allOptions() { return this.options.flatMap((o) => o.options.length ? o.allOptions() : [o]); }
    val(value) {
      if (value === undefined) return this.id === '#node-config-input-deviceSelect' && !this.allOptions().some((o) => o.attrs.value === this.value) ? null : this.value;
      this.value = value; return this;
    }
    text(value) { this.label = value; return this; }
    attr(key, value) { if (value === undefined) return this.attrs[key]; this.attrs[key] = value; return this; }
    prop(key, value) { this.attrs[key] = value; return this; }
    on(event, handler) { this.handlers[event] = handler; return this; }
    append(option) { this.options.push(option); return this; }
    empty() { this.options = []; return this; }
    add(other) { return { prop: (key, value) => { this.prop(key, value); other.prop(key, value); return this.add(other); }, add: (third) => ({ prop: (key, value) => { this.prop(key, value); other.prop(key, value); third.prop(key, value); } }) }; }
    find(selector) {
      if (selector === 'option:selected') return this.options.find((o) => o.attrs.value === this.value);
      return { each: (fn) => this.options.forEach((o) => fn.call(o)) };
    }
  }
  function $(selector) {
    if (selector instanceof Element) return selector;
    if (selector.startsWith('<')) return new Element();
    if (!elements.has(selector)) elements.set(selector, new Element(selector));
    return elements.get(selector);
  }
  function request(options) {
    const callbacks = {};
    const result = { options, resolve(value) { callbacks.done?.(value); callbacks.always?.(); } };
    for (const name of ['done', 'fail', 'always']) result[name] = (fn) => { callbacks[name] = fn; return result; };
    requests.push(result); return result;
  }
  $.getJSON = (url, data) => request({ url, data });
  $.ajax = request;
  let definition;
  const html = readFileSync(new URL('../nodes/truma-inetx-device.html', import.meta.url), 'utf8');
  runInNewContext(html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1], {
    $, window: { confirm: (message) => { confirmations.push(message); return confirm; } },
    RED: { nodes: { registerType: (_, value) => { definition = value; } } }
  });
  const field = (name) => $(`#node-config-input-${name}`);
  field('adapter').val('hci1'); field('bluetooth').val('bluez');
  field('deviceAddress').val('FC:A8:9B:57:E6:C1'); field('deviceName').val('Truma'); field('targetMode').val('device');
  definition.oneditprepare.call({ id: 'test' });
  return { field, requests, confirmations };
}

test('editor forget requires confirmation and sends the exact adapter and address', () => {
  const canceled = editor(false);
  canceled.field('forget').handlers.click();
  assert.equal(canceled.requests.length, 1); // Adapter list only; no mutation.
  const { field, requests, confirmations } = editor();
  field('forget').handlers.click();
  assert.match(confirmations[0], /FC:A8:9B:57:E6:C1.*hci1/);
  const req = requests.at(-1);
  assert.equal(req.options.url, 'truma-inetx/unpair');
  assert.deepEqual(JSON.parse(req.options.data), { adapter: 'hci1', deviceAddress: 'FC:A8:9B:57:E6:C1' });
  assert.equal(field('search').attrs.disabled, true);
  req.resolve({ status: 'removed' });
  assert.equal(field('search').attrs.disabled, false);
  field('search').handlers.click();
  requests.at(-1).resolve([]);
  assert.equal(field('targetMode').val(), 'none');
  assert.equal(field('deviceAddress').val(), '');
  assert.notEqual(field('deviceSelect').val(), null);
});

test('editor saves the resolved identity returned by pairing a random address', () => {
  const { field, requests } = editor();
  field('deviceAddress').val('5A:0D:F1:74:99:FE');
  field('search').handlers.click();
  requests.at(-1).resolve([{ address: '5A:0D:F1:74:99:FE', name: 'Truma', paired: false, backend: 'bluez' }]);
  field('pair').handlers.click();
  requests.at(-1).resolve({ bluez: { paired: true, address: 'FC:A8:9B:57:E6:C1', name: 'Truma' } });
  assert.equal(field('deviceAddress').val(), 'FC:A8:9B:57:E6:C1');
  assert.equal(JSON.parse(field('deviceSelect').val()).address, 'FC:A8:9B:57:E6:C1');
  assert.equal(field('deviceSelect').allOptions().length, 3); // None + automatic + resolved identity; no old random record.
  assert.match(field('deviceSelect').allOptions()[2].label, /paired on host/);
});

for (const status of ['removed', 'not-found']) {
  test(`editor removes forgotten Bluetooth records (${status}) and clears the saved target`, () => {
    const { field, requests } = editor();
    field('search').handlers.click();
    requests.at(-1).resolve([
      { name: 'Truma', address: 'FC:A8:9B:57:E6:C1', backend: 'bluez', paired: true },
      { name: 'Truma', address: '59:E4:0E:97:5E:85', backend: 'bluez', paired: false }
    ]);
    field('forget').handlers.click();
    requests.at(-1).resolve({ status });
    const groups = field('deviceSelect').options;
    assert.equal(groups.length, 3); // None, automatic, remaining Bluetooth records.
    assert.equal(field('deviceSelect').val(), 'none');
    assert.equal(field('deviceName').val(), '');
    assert.equal(groups[2].options.length, 1);
    assert.match(groups[2].options[0].label, /59:E4:0E:97:5E:85/);
    assert.match(field('search-status').label, /^1 Bluetooth record;/);
    // Forget must not silently switch the flow to the other panel or automatic selection.
    assert.equal(field('deviceAddress').val(), '');
    assert.equal(field('targetMode').val(), 'none');
    field('deviceSelect').val(groups[2].options[0].attrs.value);
    field('deviceSelect').handlers.change();
    assert.equal(field('deviceSelect').allOptions().length, 3);
    assert.equal(field('deviceAddress').val(), '59:E4:0E:97:5E:85');
  });
}

test('editor matches saved targets by address even when the discovered name changes', () => {
  const { field, requests } = editor();
  field('search').handlers.click();
  requests.at(-1).resolve([{ name: 'Truma iNetX-57E6C1', address: 'fc:a8:9b:57:e6:c1', backend: 'bluez' }]);
  assert.equal(field('deviceSelect').allOptions().length, 3);
  assert.equal(field('deviceName').val(), 'Truma iNetX-57E6C1');
  assert.notEqual(field('deviceSelect').val(), null);
});

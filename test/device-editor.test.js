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
    prop(key, value) { if (value === undefined) return this.attrs[key] || false; this.attrs[key] = value; return this; }
    on(event, handler) { this.handlers[event] = handler; return this; }
    toggle(value) { this.visible = value; return this; }
    trigger(event) { this.handlers[event]?.(); return this; }
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
    const result = { options, resolve(value) { callbacks.done?.(value); callbacks.always?.(); }, reject(error) { callbacks.fail?.({ responseJSON: { error } }); callbacks.always?.(); } };
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

const saved = { name: 'Truma', address: 'FC:A8:9B:57:E6:C1', backend: 'bluez', paired: true };
const other = { name: 'Truma', address: '59:E4:0E:97:5E:85', backend: 'bluez', paired: false };
function forgetList(ui, devices = [saved, other]) {
  ui.field('forget').trigger('click');
  assert.equal(ui.requests.at(-1).options.url, 'truma-inetx/devices');
  ui.requests.at(-1).resolve(devices);
}
function select(ui, device) {
  ui.field('deviceSelect').val(JSON.stringify({ name: device.name, address: device.address })).trigger('change');
}

test('forget lists records first; cancellation never removes a bond', () => {
  const ui = editor(false);
  forgetList(ui);
  assert.equal(ui.confirmations.length, 0);
  assert.equal(ui.field('forget-panel').visible, true);
  ui.field('forget-device').val(saved.address).trigger('change');
  ui.field('forget-confirm').trigger('click');
  assert.equal(ui.requests.some((req) => req.options.url.endsWith('/unpair')), false);
  ui.field('forget-cancel').trigger('click');
  assert.equal(ui.field('forget-panel').visible, false);
  assert.equal(ui.field('deviceAddress').val(), saved.address);
});

test('forget confirms the chosen record and sends its exact adapter and address', () => {
  const ui = editor();
  forgetList(ui);
  ui.field('forget-device').val(saved.address).trigger('change');
  ui.field('forget-confirm').trigger('click');
  assert.match(ui.confirmations[0], /FC:A8:9B:57:E6:C1.*hci1/);
  const req = ui.requests.at(-1);
  assert.equal(req.options.url, 'truma-inetx/unpair');
  assert.deepEqual(JSON.parse(req.options.data), { adapter: 'hci1', deviceAddress: saved.address });
  assert.equal(ui.field('search').attrs.disabled, true);
  req.resolve({ status: 'removed' });
  assert.equal(ui.field('search').attrs.disabled, false);
  assert.equal(ui.field('targetMode').val(), 'none');
  assert.equal(ui.field('deviceAddress').val(), '');
  assert.equal(ui.field('deviceSelect').val(), 'none');
});

test('changing adapters invalidates the forget list', () => {
  const ui = editor();
  forgetList(ui);
  ui.field('forget-device').val(saved.address).trigger('change');
  ui.field('adapter').val('hci0').trigger('change');
  ui.field('forget-confirm').trigger('click');
  assert.equal(ui.field('forget-panel').visible, false);
  assert.equal(ui.confirmations.length, 0);
});

test('forgetting another record or a failed removal keeps the selected target', () => {
  const ui = editor();
  forgetList(ui);
  ui.field('forget-device').val(other.address).trigger('change');
  ui.field('forget-confirm').trigger('click');
  ui.requests.at(-1).resolve({ status: 'removed' });
  assert.equal(ui.field('deviceAddress').val(), saved.address);
  forgetList(ui);
  ui.field('forget-device').val(saved.address).trigger('change');
  ui.field('forget-confirm').trigger('click');
  ui.requests.at(-1).reject('Bluetooth unavailable');
  assert.equal(ui.field('deviceAddress').val(), saved.address);
  assert.equal(ui.field('forget-panel').visible, true);
});

test('adapter dropdown labels hardware and converts a saved hci name to its stable MAC', () => {
  const { field, requests } = editor();
  requests.find((req) => req.options.url === 'truma-inetx/adapters').resolve([
    { name: 'hci1', address: '11:22:33:44:55:66', path: '/org/bluez/hci1', powered: true }
  ]);
  assert.equal(field('adapter').val(), '11:22:33:44:55:66');
  assert.equal(field('adapter').options[1].label, 'hci1 (11:22:33:44:55:66)');
  const other = editor();
  other.requests.find((req) => req.options.url === 'truma-inetx/adapters').resolve([]);
  assert.equal(other.field('adapter').val(), 'hci1');
  assert.match(other.field('adapter').options.at(-1).label, /unavailable/);
});

test('opening and searching do not pair; selecting pairs without a passkey', () => {
  const ui = editor();
  assert.equal(ui.field('connectionMode').val(), 'request');
  assert.equal(ui.field('idleTimeoutMinutes').val(), 1);
  ui.field('search').trigger('click');
  ui.requests.at(-1).resolve([saved, other]);
  assert.equal(ui.requests.some((req) => req.options.url.endsWith('/pair')), false);
  assert.equal(ui.field('deviceAddress').val(), saved.address);
  assert.deepEqual(ui.field('deviceSelect').allOptions().map((option) => option.label), ['No device selected', 'Truma', 'Truma']);
  select(ui, other);
  assert.equal(ui.requests.at(-1).options.url, 'truma-inetx/pair');
  assert.deepEqual(JSON.parse(ui.requests.at(-1).options.data), { adapter: 'hci1', deviceAddress: other.address });
  assert.equal(ui.field('deviceAddress').val(), saved.address); // Provisional until pairing succeeds.
  assert.equal(ui.field('deviceSelect').attrs.disabled, true);
  ui.requests.at(-1).reject('Pairing failed');
  assert.equal(ui.field('deviceAddress').val(), saved.address);
  assert.equal(ui.field('deviceSelect').attrs.disabled, false);
  assert.equal(JSON.parse(ui.field('deviceSelect').val()).address, saved.address);
  ui.field('connectionMode').val('idle').trigger('change');
  assert.equal(ui.field('idle-timeout-row').visible, true);
  ui.field('connectionMode').val('request').trigger('change');
  assert.equal(ui.field('idle-timeout-row').visible, false);
});

test('editor saves the resolved identity returned by pairing a random address', () => {
  const ui = editor();
  ui.field('search').trigger('click');
  ui.requests.at(-1).resolve([other]);
  select(ui, other);
  ui.requests.at(-1).resolve({ bluez: { paired: true, address: saved.address, name: 'Truma iNetX-57E6C1' } });
  assert.equal(ui.field('deviceAddress').val(), saved.address);
  assert.equal(JSON.parse(ui.field('deviceSelect').val()).address, saved.address);
  assert.equal(ui.field('deviceSelect').allOptions().length, 2); // None + resolved identity.
  assert.equal(ui.field('deviceSelect').allOptions()[1].label, 'Truma iNetX-57E6C1');
});

test('unconfirmed pairing preserves the previous target', () => {
  const ui = editor();
  ui.field('search').trigger('click');
  ui.requests.at(-1).resolve([other]);
  select(ui, other);
  ui.requests.at(-1).resolve({ bluez: { paired: false } });
  assert.equal(ui.field('deviceAddress').val(), saved.address);
  assert.equal(JSON.parse(ui.field('deviceSelect').val()).address, saved.address);
});

for (const status of ['removed', 'not-found']) {
  test(`forget clears only the chosen address (${status}), keeping same-name records`, () => {
    const ui = editor();
    ui.field('search').trigger('click');
    ui.requests.at(-1).resolve([saved, other]);
    forgetList(ui);
    ui.field('forget-device').val(saved.address).trigger('change');
    ui.field('forget-confirm').trigger('click');
    ui.requests.at(-1).resolve({ status });
    const options = ui.field('deviceSelect').allOptions();
    assert.equal(options.length, 2);
    assert.equal(JSON.parse(options[1].attrs.value).address, other.address);
    assert.equal(ui.field('deviceSelect').val(), 'none');
    assert.equal(ui.field('deviceAddress').val(), '');
    assert.equal(ui.field('targetMode').val(), 'none');
  });
}

test('editor matches saved targets by address even when the discovered name changes', () => {
  const { field, requests } = editor();
  field('search').trigger('click');
  requests.at(-1).resolve([{ name: 'Truma iNetX-57E6C1', address: 'fc:a8:9b:57:e6:c1', backend: 'bluez' }]);
  assert.equal(field('deviceSelect').allOptions().length, 2);
  assert.equal(field('deviceName').val(), 'Truma iNetX-57E6C1');
  assert.notEqual(field('deviceSelect').val(), null);
});

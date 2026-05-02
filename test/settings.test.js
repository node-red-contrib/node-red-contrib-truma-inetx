import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTrumaFrame, parseSettingsJson } from '../dist/index.js';

test('extracts topic lists and parameter values from response frames', () => {
  const topicList = buildTrumaFrame('00050000', '0300', '8200', [0, { tn: ['Identify', 'EnergySrc'] }]);
  const deviceList = buildTrumaFrame('00050000', '0200', '0100', [0, { Devices: [0x0405, 0x0201] }]);
  const parameters = buildTrumaFrame('00050504', '0300', '8400', {
    avail: 1,
    topics: [
      {
        tn: 'Identify',
        parameters: [{ tn: 'Identify', pn: 'SwBdNr', type: 1, min: 0, max: 65535, avail: 1, perm: 0, v: 1 }]
      }
    ]
  });

  const json = parseSettingsJson([topicList, deviceList, parameters]);

  assert.deepEqual(json.topicLists, ['Identify', 'EnergySrc']);
  assert.equal(json.topics.Identify.SwBdNr.v, 1);
  assert.equal(json.topics.Identify.SwBdNr.type, 1);
  assert.deepEqual(json.diagnostics.topicGroups, { Identify: ['0x0405'] });
  assert.deepEqual(json.diagnostics.unreadTopics, ['EnergySrc']);
  assert.deepEqual(json.diagnostics.deviceGroups, ['0x0201', '0x0405']);
  assert.deepEqual(json.diagnostics.unreadDeviceGroups, ['0x0201']);
});

test('redacts sensitive values by default', () => {
  const mobileIdentity = buildTrumaFrame('00050105', '0300', '8400', {
    avail: 1,
    topics: [
      {
        tn: 'MobileIdentity',
        parameters: [{ tn: 'MobileIdentity', pn: 'Uuid', type: 4, avail: 1, v: 'abcdef' }]
      }
    ]
  });

  const json = parseSettingsJson([mobileIdentity]);

  assert.equal(json.topics.MobileIdentity.Uuid.v, '<redacted>');
});

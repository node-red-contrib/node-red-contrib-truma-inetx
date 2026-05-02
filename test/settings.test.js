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
  assert.equal(json.topics.Identify.group, '0x0405');
  assert.equal(json.topics.Identify.parameters.SwBdNr.value, 1);
  assert.equal(json.topics.Identify.parameters.SwBdNr.type, 1);
  assert.equal(json.topics.Identify.parameters.SwBdNr.available, 1);
  assert.equal('tn' in json.topics.Identify.parameters.SwBdNr, false);
  assert.equal('pn' in json.topics.Identify.parameters.SwBdNr, false);
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

  assert.equal(json.topics.MobileIdentity.parameters.Uuid.value, '<redacted>');
});

test('normalizes enum field names in parameter output', () => {
  const response = buildTrumaFrame('00050105', '0300', '8400', {
    avail: 1,
    topics: [
      {
        tn: 'PowerMgmt',
        parameters: [
          {
            tn: 'PowerMgmt',
            pn: 'PwrMode',
            type: 2,
            enum: [
              { n: 'Eco', v: 1, a: 1 },
              { n: 'Boost', v: 3, a: 0 }
            ],
            avail: 1,
            v: 3
          }
        ]
      }
    ]
  });

  const json = parseSettingsJson([response]);

  assert.deepEqual(json.topics.PowerMgmt.parameters.PwrMode.enum, [
    { name: 'Eco', value: 1, available: 1 },
    { name: 'Boost', value: 3, available: 0 }
  ]);
  assert.equal(json.topics.PowerMgmt.parameters.PwrMode.value, 3);
});

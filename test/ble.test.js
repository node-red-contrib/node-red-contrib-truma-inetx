import assert from 'node:assert/strict';
import test from 'node:test';

import { isTrumaPeripheral, TRUMA } from '../dist/index.js';

test('matches Truma advertisements by name prefix', () => {
  assert.equal(
    isTrumaPeripheral({
      advertisement: {
        localName: 'Truma iNetX-ABCD12'
      }
    }),
    true
  );
});

test('matches Truma advertisements by service UUID when name is absent', () => {
  assert.equal(
    isTrumaPeripheral({
      advertisement: {
        serviceUuids: [TRUMA.advertisedServiceUuid.toUpperCase()]
      }
    }),
    true
  );
});

test('ignores unrelated advertisements', () => {
  assert.equal(
    isTrumaPeripheral({
      advertisement: {
        localName: 'Other device',
        serviceUuids: ['180a']
      }
    }),
    false
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelAddressError, parseChannel, resolveChannel } from '../src/lamps/address.ts';

test('parses the three channel address forms', () => {
  assert.deepEqual(parseChannel('relay-3'), { scheme: 'relay', index: 3 });
  assert.deepEqual(parseChannel('esp32:192.168.1.50/3'), { scheme: 'esp32', host: '192.168.1.50', port: 80, channel: 3 });
  assert.deepEqual(parseChannel('esp32:relay-hall.local:8080/8'), {
    scheme: 'esp32',
    host: 'relay-hall.local',
    port: 8080,
    channel: 8,
  });
  assert.deepEqual(parseChannel('modbus:192.168.1.60:502/7'), { scheme: 'modbus', host: '192.168.1.60', port: 502, channel: 7 });
  assert.deepEqual(parseChannel('modbus:192.168.1.60/1'), { scheme: 'modbus', host: '192.168.1.60', port: 502, channel: 1 });
});

test('rejects malformed addresses with a readable reason', () => {
  for (const bad of ['', 'relay-0', 'relay-x', 'esp32:/3', 'esp32:192.168.1.50', 'esp32:192.168.1.50/0', 'esp32:192.168.1.50/33',
    'esp32:192.168.1.300/3', 'modbus:host:70000/1', 'mqtt:broker/1', 'esp32:a b/1']) {
    assert.throws(() => parseChannel(bad), ChannelAddressError, bad);
  }
  assert.throws(() => parseChannel('esp32:192.168.1.50/99'), /1–32/);
});

test('relay-N channels map onto the default host of the driver', () => {
  assert.deepEqual(resolveChannel('relay-4', 'esp32', '192.168.1.50'), { scheme: 'esp32', host: '192.168.1.50', port: 80, channel: 4 });
  assert.deepEqual(resolveChannel('relay-4', 'modbus', '192.168.1.60:5020'), {
    scheme: 'modbus',
    host: '192.168.1.60',
    port: 5020,
    channel: 4,
  });
  assert.throws(() => resolveChannel('relay-4', 'esp32', undefined), /HUB_ESP32_HOST/);
  assert.throws(() => resolveChannel('modbus:192.168.1.60/1', 'esp32', '192.168.1.50'), /не обслуживает/);
  assert.deepEqual(resolveChannel('esp32:10.0.0.9/2', 'esp32', '192.168.1.50'), { scheme: 'esp32', host: '10.0.0.9', port: 80, channel: 2 });
});

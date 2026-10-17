import { findBluezAdapterPath, matchesBluezDevice, type BluezObjects } from './selection.js';

export interface UnpairOptions {
  adapter: string;
  deviceAddress: string;
}

interface RemovalBus {
  getProxyObject(service: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  disconnect(): void;
}

export function validateUnpairOptions(options: UnpairOptions): void {
  if (typeof options.adapter !== 'string' || !options.adapter.trim()) throw new Error('Select a specific Bluetooth adapter before forgetting pairing.');
  if (typeof options.deviceAddress !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(options.deviceAddress)) throw new Error('Select a specific device MAC address before forgetting pairing.');
}

/** Removes the host bond and cached device, without scanning or choosing a device by name. */
export async function removeBluezDevice(bus: RemovalBus, options: UnpairOptions): Promise<{ status: 'removed' | 'not-found'; adapter: string; deviceAddress: string }> {
  try {
    validateUnpairOptions(options);
    const manager = (await bus.getProxyObject('org.bluez', '/')).getInterface('org.freedesktop.DBus.ObjectManager') as { GetManagedObjects(): Promise<BluezObjects> };
    const objects = await manager.GetManagedObjects();
    const adapter = findBluezAdapterPath(objects, options.adapter)!;
    const devicePath = Object.keys(objects).find((path) => {
      const device = objects[path]?.['org.bluez.Device1'];
      return device && matchesBluezDevice(path, device, { adapterPath: adapter, deviceAddress: options.deviceAddress, namePrefix: '', serviceUuid: undefined });
    });
    if (!devicePath) return { status: 'not-found', adapter, deviceAddress: options.deviceAddress };
    const controller = (await bus.getProxyObject('org.bluez', adapter)).getInterface('org.bluez.Adapter1') as { RemoveDevice(path: string): Promise<void> };
    await controller.RemoveDevice(devicePath);
    return { status: 'removed', adapter, deviceAddress: options.deviceAddress };
  } finally {
    bus.disconnect();
  }
}

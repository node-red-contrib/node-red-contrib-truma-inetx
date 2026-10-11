export type BluezObjects = Record<string, Record<string, Record<string, unknown>>>;

export interface BluetoothAdapter {
  path: string;
  name: string;
  address: string;
  powered: boolean;
}

export function unbox(value: unknown): unknown {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

export function listBluezAdapters(objects: BluezObjects): BluetoothAdapter[] {
  return Object.entries(objects).flatMap(([path, interfaces]) => {
    const adapter = interfaces['org.bluez.Adapter1'];
    return adapter ? [{ path, name: path.split('/').pop()!, address: String(unbox(adapter.Address) || ''), powered: unbox(adapter.Powered) === true }] : [];
  }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function findBluezAdapterPath(objects: BluezObjects, selector?: string): string | null {
  const adapters = listBluezAdapters(objects);
  const wanted = selector?.trim().toLowerCase();
  if (!wanted) return adapters[0]?.path ?? null;
  const adapter = adapters.find((item) => [item.path, item.name, item.address].some((value) => value.toLowerCase() === wanted));
  if (!adapter) throw new Error(`Bluetooth adapter "${selector}" was not found. Select an available adapter; no fallback was used.`);
  return adapter.path;
}

export interface BluezDeviceFilter {
  adapterPath: string;
  namePrefix: string;
  deviceName?: string;
  deviceAddress?: string;
  serviceUuid: string | undefined;
}

export function matchesBluezDevice(path: string, device: Record<string, unknown>, filter: BluezDeviceFilter): boolean {
  if (!path.startsWith(`${filter.adapterPath}/`)) return false;
  const name = String(unbox(device.Name) || unbox(device.Alias) || '');
  const address = String(unbox(device.Address) || '');
  // An explicit address is authoritative, even if the advertised name changed.
  if (filter.deviceAddress) return address.toLowerCase() === filter.deviceAddress.toLowerCase();
  if (filter.deviceName) return name === filter.deviceName;
  const uuids = unbox(device.UUIDs);
  return name.startsWith(filter.namePrefix) || !!(filter.serviceUuid && Array.isArray(uuids) && uuids.some((uuid) => String(uuid).toLowerCase() === filter.serviceUuid?.toLowerCase()));
}

import CoreBluetooth
import Foundation

let advertisedService = CBUUID(string: "FC310001-F3B2-11E8-8EB2-F2801F1B9FD1")
let trumaService = CBUUID(string: "FC314000-F3B2-11E8-8EB2-F2801F1B9FD1")
let controlCharacteristic = CBUUID(string: "FC314001-F3B2-11E8-8EB2-F2801F1B9FD1")
let dataCharacteristic = CBUUID(string: "FC314003-F3B2-11E8-8EB2-F2801F1B9FD1")
let softwareRevisionCharacteristic = CBUUID(string: "2A28")

final class TrumaCoreBluetoothProbe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var timeout: Timer?
    private var connectProgress: Timer?
    private var connectStartedAt: Date?
    private var lastAdvertisementState: String?
    private let namePrefix: String
    private let useServiceFilter: Bool
    private let keepScanningDuringConnect: Bool
    private let noConnectOptions: Bool
    private let requirePairingState: Bool
    private let holdConnection: Bool
    private let timeoutSeconds: TimeInterval

    init(
        namePrefix: String,
        useServiceFilter: Bool,
        keepScanningDuringConnect: Bool,
        noConnectOptions: Bool,
        requirePairingState: Bool,
        holdConnection: Bool,
        timeoutSeconds: TimeInterval
    ) {
        self.namePrefix = namePrefix
        self.useServiceFilter = useServiceFilter
        self.keepScanningDuringConnect = keepScanningDuringConnect
        self.noConnectOptions = noConnectOptions
        self.requirePairingState = requirePairingState
        self.holdConnection = holdConnection
        self.timeoutSeconds = timeoutSeconds
        super.init()
        self.central = CBCentralManager(delegate: self, queue: .main)
        if timeoutSeconds > 0 && !holdConnection {
            self.timeout = Timer.scheduledTimer(withTimeInterval: timeoutSeconds, repeats: false) { _ in
                print("[swift-pair] Timeout. Stopping.")
                self.stop(exitCode: 2)
            }
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        print("[swift-pair] central state: \(stateName(central.state))")
        guard central.state == .poweredOn else { return }

        let connected = central.retrieveConnectedPeripherals(withServices: [advertisedService, trumaService])
        if connected.isEmpty {
            print("[swift-pair] no already-connected Truma peripherals reported by CoreBluetooth")
        } else {
            let ids = connected.map { "\($0.name ?? "<unnamed>")/\($0.identifier.uuidString)" }.joined(separator: ", ")
            print("[swift-pair] already-connected peripherals: \(ids)")
        }

        let services = useServiceFilter ? [advertisedService] : nil
        if useServiceFilter {
            print("[swift-pair] scanning for advertised service \(advertisedService.uuidString)")
        } else {
            print("[swift-pair] scanning all advertisements and matching name prefix \(namePrefix)")
        }
        central.scanForPeripherals(withServices: services, options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: true
        ])
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard self.peripheral == nil else { return }

        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
        guard name.hasPrefix(namePrefix) else { return }

        let advertisementState = trumaAdvertisementState(advertisementData)
        if requirePairingState && advertisementState != "pairing-or-ble-active" {
            if lastAdvertisementState != advertisementState {
                print("[swift-pair] saw \(name) advertisement state=\(advertisementState); waiting for mfg=730c0001 before connecting")
                lastAdvertisementState = advertisementState
            }
            return
        }

        self.peripheral = peripheral
        peripheral.delegate = self

        print("[swift-pair] discovered \(name) id=\(peripheral.identifier.uuidString) rssi=\(RSSI)")
        print("[swift-pair] advertisement: \(advertisementSummary(advertisementData)) state=\(advertisementState)")
        print("[swift-pair] connecting via CoreBluetooth...")

        if keepScanningDuringConnect {
            print("[swift-pair] keeping scan active during connect")
        } else {
            print("[swift-pair] stopping scan before connect")
            central.stopScan()
        }

        connectStartedAt = Date()
        connectProgress = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            let elapsed = self.connectStartedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0
            print("[swift-pair] still waiting for didConnect... elapsed=\(elapsed)s peripheralState=\(peripheralStateName(peripheral.state))")
        }

        let options = noConnectOptions ? nil : [
            CBConnectPeripheralOptionNotifyOnDisconnectionKey: true
        ]
        if noConnectOptions {
            print("[swift-pair] using no CoreBluetooth connect options")
        }
        central.connect(peripheral, options: options)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectProgress?.invalidate()
        connectProgress = nil
        print("[swift-pair] connected: \(peripheral.identifier.uuidString)")
        print("[swift-pair] discovering services...")
        if holdConnection {
            print("[swift-pair] hold mode is active; keep this process running while using npm run read in another terminal")
        }
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connectProgress?.invalidate()
        connectProgress = nil
        print("[swift-pair] failed to connect: \(error?.localizedDescription ?? "<no error>")")
        stop(exitCode: 3)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connectProgress?.invalidate()
        connectProgress = nil
        print("[swift-pair] disconnected: \(error?.localizedDescription ?? "<no error>")")
        if holdConnection {
            stop(exitCode: 5)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            print("[swift-pair] service discovery error: \(error.localizedDescription)")
            stop(exitCode: 4)
            return
        }

        let services = peripheral.services ?? []
        print("[swift-pair] discovered services: \(services.map { $0.uuid.uuidString }.joined(separator: ", "))")
        for service in services {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error {
            print("[swift-pair] characteristic discovery error for \(service.uuid.uuidString): \(error.localizedDescription)")
            return
        }

        let characteristics = service.characteristics ?? []
        for characteristic in characteristics {
            print("[swift-pair] characteristic \(characteristic.uuid.uuidString) props=\(properties(characteristic.properties))")

            if characteristic.uuid == softwareRevisionCharacteristic {
                print("[swift-pair] reading software revision")
                peripheral.readValue(for: characteristic)
            }

            if service.uuid == trumaService && characteristic.uuid == controlCharacteristic {
                print("[swift-pair] subscribing to Truma control characteristic; this should trigger pairing if protected")
                peripheral.setNotifyValue(true, for: characteristic)
            }

            if service.uuid == trumaService && characteristic.uuid == dataCharacteristic {
                print("[swift-pair] subscribing to Truma data characteristic")
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            print("[swift-pair] notification state error for \(characteristic.uuid.uuidString): \(error.localizedDescription)")
        } else {
            print("[swift-pair] notification state for \(characteristic.uuid.uuidString): isNotifying=\(characteristic.isNotifying)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            print("[swift-pair] read/notify error for \(characteristic.uuid.uuidString): \(error.localizedDescription)")
            return
        }
        let data = characteristic.value ?? Data()
        if characteristic.uuid == softwareRevisionCharacteristic, let text = String(data: data, encoding: .utf8) {
            print("[swift-pair] software revision: \(text)")
        } else {
            print("[swift-pair] value \(characteristic.uuid.uuidString): \(data.map { String(format: "%02x", $0) }.joined())")
        }
    }

    private func stop(exitCode: Int32) {
        timeout?.invalidate()
        connectProgress?.invalidate()
        if let peripheral {
            central.cancelPeripheralConnection(peripheral)
        }
        central.stopScan()
        exit(exitCode)
    }
}

func stateName(_ state: CBManagerState) -> String {
    switch state {
    case .unknown: return "unknown"
    case .resetting: return "resetting"
    case .unsupported: return "unsupported"
    case .unauthorized: return "unauthorized"
    case .poweredOff: return "poweredOff"
    case .poweredOn: return "poweredOn"
    @unknown default: return "unknown-new-state"
    }
}

func peripheralStateName(_ state: CBPeripheralState) -> String {
    switch state {
    case .disconnected: return "disconnected"
    case .connecting: return "connecting"
    case .connected: return "connected"
    case .disconnecting: return "disconnecting"
    @unknown default: return "unknown-new-state"
    }
}

func advertisementSummary(_ advertisementData: [String: Any]) -> String {
    var parts: [String] = []
    if let isConnectable = advertisementData[CBAdvertisementDataIsConnectable] {
        parts.append("connectable=\(isConnectable)")
    }
    if let name = advertisementData[CBAdvertisementDataLocalNameKey] {
        parts.append("name=\(name)")
    }
    if let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
        parts.append("mfg=\(manufacturer.map { String(format: "%02x", $0) }.joined())")
    }
    if let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
        parts.append("services=\(services.map { $0.uuidString }.joined(separator: ","))")
    }
    return parts.joined(separator: " ")
}

func trumaAdvertisementState(_ advertisementData: [String: Any]) -> String {
    guard let manufacturer = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data else {
        return "unknown-no-manufacturer-data"
    }

    let bytes = [UInt8](manufacturer)
    guard bytes.count >= 4, bytes[0] == 0x73, bytes[1] == 0x0c else {
        return "unknown-manufacturer-\(bytes.map { String(format: "%02x", $0) }.joined())"
    }

    switch bytes[3] {
    case 0x00: return "normal-or-inactive"
    case 0x01: return "pairing-or-ble-active"
    default: return "unknown-truma-state-\(String(format: "%02x", bytes[3]))"
    }
}

func properties(_ properties: CBCharacteristicProperties) -> String {
    var names: [String] = []
    if properties.contains(.read) { names.append("read") }
    if properties.contains(.write) { names.append("write") }
    if properties.contains(.writeWithoutResponse) { names.append("writeWithoutResponse") }
    if properties.contains(.notify) { names.append("notify") }
    if properties.contains(.indicate) { names.append("indicate") }
    return names.joined(separator: ",")
}

let args = CommandLine.arguments.dropFirst()
let namePrefix = value(after: "--name", in: Array(args)) ?? "Truma iNetX"
let useServiceFilter = !args.contains("--no-service-filter")
let keepScanningDuringConnect = args.contains("--keep-scanning")
let noConnectOptions = args.contains("--no-connect-options")
let requirePairingState = args.contains("--require-pairing-state")
let holdConnection = args.contains("--hold")
let timeoutSeconds = TimeInterval(value(after: "--timeout", in: Array(args)) ?? "75") ?? 75
_ = TrumaCoreBluetoothProbe(
    namePrefix: namePrefix,
    useServiceFilter: useServiceFilter,
    keepScanningDuringConnect: keepScanningDuringConnect,
    noConnectOptions: noConnectOptions,
    requirePairingState: requirePairingState,
    holdConnection: holdConnection,
    timeoutSeconds: timeoutSeconds
)
RunLoop.main.run()

func value(after flag: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}

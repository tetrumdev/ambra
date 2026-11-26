import ExpoModulesCore
import Network

/// The last path seen, touched only on the monitor's serial queue.
private final class PathSignature: @unchecked Sendable {
  var value: String?
}

/// Whether the phone has any network path at all; read from any thread.
private final class PathOnline: @unchecked Sendable {
  private let lock = NSLock()
  private var current = true
  var value: Bool {
    get { lock.lock(); defer { lock.unlock() }; return current }
    set { lock.lock(); current = newValue; lock.unlock() }
  }
}

public class AmbraNetworkModule: Module {
  private var monitor: NWPathMonitor?
  private let online = PathOnline()

  private static func directory() throws -> URL {
    let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("AmbraNetwork", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    return directory
  }

  private static func call(_ operation: String, _ args: String) throws -> String {
    let directory = try directory()
    let output = directory.path.withCString { path in
      operation.withCString { method in args.withCString { body in ambra_mobile_call(path, method, body) } }
    }
    guard let output else { throw NSError(domain: "AmbraNetwork", code: 1) }
    defer { ambra_mobile_free(output) }
    return String(cString: output)
  }

  public func definition() -> ModuleDefinition {
    Name("AmbraNetwork")
    // No network at all (airplane mode, no signal): the app plays its downloads at once rather
    // than waiting for requests to the server to fail.
    Events("onPathChange")

    // A Wi-Fi change can leave connections hanging instead of failing. Rust checks them
    // the moment the system switches paths, so playback moves to the next path at once.
    OnCreate {
      // Downloaded songs are temporary; keep them out of iCloud and device backups.
      if var cache = try? AmbraNetworkModule.directory().appendingPathComponent("media-cache", isDirectory: true) {
        try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? cache.setResourceValues(values)
      }

      let monitor = NWPathMonitor()
      let previous = PathSignature()
      let online = self.online
      monitor.pathUpdateHandler = { [weak self] path in
        let reachable = path.status == .satisfied
        if online.value != reachable {
          online.value = reachable
          self?.sendEvent("onPathChange", ["online": reachable])
        }
        let interfaces = path.availableInterfaces.map { "\($0.type)-\($0.name)" }.joined(separator: ",")
        let signature = "\(path.status)|\(interfaces)"
        defer { previous.value = signature }
        guard let last = previous.value, last != signature else { return }
        _ = try? AmbraNetworkModule.call("network_changed", "{}")
      }
      monitor.start(queue: DispatchQueue(label: "com.tetrum.ambra.network-path"))
      self.monitor = monitor
    }

    OnDestroy {
      self.monitor?.cancel()
      self.monitor = nil
    }

    Function("online") { () -> Bool in
      self.online.value
    }

    AsyncFunction("call") { (operation: String, args: String) -> String in
      try AmbraNetworkModule.call(operation, args)
    }
  }
}

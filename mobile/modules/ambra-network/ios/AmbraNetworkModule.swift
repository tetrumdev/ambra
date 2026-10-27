import ExpoModulesCore

public class AmbraNetworkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AmbraNetwork")
    AsyncFunction("call") { (operation: String, args: String) -> String in
      let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("AmbraNetwork", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      let output = directory.path.withCString { path in
        operation.withCString { method in args.withCString { body in ambra_mobile_call(path, method, body) } }
      }
      guard let output else { throw NSError(domain: "AmbraNetwork", code: 1) }
      defer { ambra_mobile_free(output) }
      return String(cString: output)
    }
  }
}

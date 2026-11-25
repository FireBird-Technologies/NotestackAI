import DeviceCheck
import ExpoModulesCore

/// What guest mode needs from the iPhone (src/account/guest.ts): a token that lets our server ask Apple about this
/// device, and a random id.
public class DeviceCheckModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeviceCheck")

    Function("randomId") { () -> String in
      UUID().uuidString.lowercased()
    }

    // Null where Apple can't vouch for the device (the simulator) or can't be reached.
    AsyncFunction("generateToken") { (promise: Promise) in
      guard DCDevice.current.isSupported else {
        promise.resolve(nil)
        return
      }
      DCDevice.current.generateToken { data, _ in
        promise.resolve(data?.base64EncodedString())
      }
    }
  }
}

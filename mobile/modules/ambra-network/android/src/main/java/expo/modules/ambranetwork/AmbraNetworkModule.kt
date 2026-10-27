package expo.modules.ambranetwork

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AmbraNetworkModule : Module() {
  companion object { init { System.loadLibrary("ambra_mobile") } }
  private external fun nativeCall(directory: String, operation: String, args: String): String
  override fun definition() = ModuleDefinition {
    Name("AmbraNetwork")
    AsyncFunction("call") { operation: String, args: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")
      val directory = java.io.File(context.noBackupFilesDir, "ambra-network")
      directory.mkdirs()
      nativeCall(directory.absolutePath, operation, args)
    }
  }
}

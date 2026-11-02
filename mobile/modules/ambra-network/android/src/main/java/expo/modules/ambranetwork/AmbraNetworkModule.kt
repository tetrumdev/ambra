package expo.modules.ambranetwork

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class AmbraNetworkModule : Module() {
  companion object { init { System.loadLibrary("ambra_mobile") } }
  private external fun nativeCall(directory: String, operation: String, args: String): String
  private val background = Executors.newSingleThreadExecutor()
  private var callback: ConnectivityManager.NetworkCallback? = null

  private fun directory(): String {
    val context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")
    val directory = java.io.File(context.noBackupFilesDir, "ambra-network")
    directory.mkdirs()
    return directory.absolutePath
  }

  override fun definition() = ModuleDefinition {
    Name("AmbraNetwork")

    // A Wi-Fi change can leave connections hanging instead of failing. Rust checks them
    // the moment the default network changes, so playback moves to the next path at once.
    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return@OnCreate
      val path = directory()
      val notify = { background.execute { runCatching { nativeCall(path, "network_changed", "{}") } } }
      val watcher = object : ConnectivityManager.NetworkCallback() {
        private var current: Network? = null
        override fun onAvailable(network: Network) {
          if (current != null && current != network) notify()
          current = network
        }
        override fun onLost(network: Network) {
          if (current == network) { current = null; notify() }
        }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
          if (current != null && current != network) { current = network; notify() }
        }
      }
      runCatching { connectivity.registerDefaultNetworkCallback(watcher) }.onSuccess { callback = watcher }
    }

    OnDestroy {
      val context = appContext.reactContext
      val connectivity = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      callback?.let { runCatching { connectivity?.unregisterNetworkCallback(it) } }
      callback = null
      background.shutdown()
    }

    AsyncFunction("call") { operation: String, args: String ->
      nativeCall(directory(), operation, args)
    }
  }
}

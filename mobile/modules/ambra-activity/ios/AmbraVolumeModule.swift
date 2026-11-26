import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

/// The phone's system volume, the one its buttons set, so the app's volume slider moves it too.
/// iOS lets apps change it only through the system volume slider, kept here off screen; while it
/// is in a window, iOS also doesn't show its volume overlay over the app's own slider.
public class AmbraVolumeModule: Module {
  private var volumeView: MPVolumeView?
  private var watching: NSKeyValueObservation?

  public func definition() -> ModuleDefinition {
    Name("AmbraVolume")
    Events("onChange")

    // The buttons, Control Center or the app itself moved it: the app's slider follows.
    OnStartObserving {
      self.watching = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] session, _ in
        self?.sendEvent("onChange", ["volume": Double(session.outputVolume)])
      }
    }
    OnStopObserving {
      self.watching?.invalidate()
      self.watching = nil
    }

    Function("get") { () -> Double in
      Double(AVAudioSession.sharedInstance().outputVolume)
    }

    AsyncFunction("set") { (volume: Double) in
      let view = self.volumeView ?? MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
      self.volumeView = view
      if view.superview == nil {
        let window = UIApplication.shared.connectedScenes
          .compactMap { ($0 as? UIWindowScene)?.windows.first { $0.isKeyWindow } }
          .first
        window?.addSubview(view)
        view.layoutIfNeeded()
      }
      guard let slider = view.subviews.compactMap({ $0 as? UISlider }).first else { return }
      slider.setValue(Float(min(1, max(0, volume))), animated: false)
      slider.sendActions(for: .valueChanged)
    }.runOnQueue(.main)
  }
}

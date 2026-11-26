import ActivityKit
import ExpoModulesCore

/// Must match `DownloadActivityAttributes` in targets/downloads, which draws it.
struct DownloadActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var done: Int
    var total: Int
    var title: String?
    var finished: Bool
  }
}

/// Starts, moves and ends the downloads Live Activity (Dynamic Island and Lock Screen).
public class AmbraActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AmbraActivity")

    AsyncFunction("show") { (done: Int, total: Int, title: String?) in
      guard #available(iOS 16.2, *) else { return }
      let state = DownloadActivityAttributes.ContentState(done: done, total: total, title: title, finished: false)
      let content = ActivityContent(state: state, staleDate: nil)
      if let current = Activity<DownloadActivityAttributes>.activities.first {
        await current.update(content)
        return
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
      _ = try? Activity.request(attributes: DownloadActivityAttributes(), content: content, pushType: nil)
    }

    AsyncFunction("finish") { (total: Int) in
      guard #available(iOS 16.2, *) else { return }
      let state = DownloadActivityAttributes.ContentState(done: total, total: total, title: nil, finished: true)
      // The check stays a moment, then the island lets go of it.
      for activity in Activity<DownloadActivityAttributes>.activities {
        await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(4)))
      }
    }
  }
}

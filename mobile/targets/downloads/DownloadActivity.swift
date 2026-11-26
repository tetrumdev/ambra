import ActivityKit
import SwiftUI
import WidgetKit

/// Must match `DownloadActivityAttributes` in modules/ambra-activity/ios, which starts and updates it.
struct DownloadActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var done: Int
    var total: Int
    var title: String?
    var finished: Bool
  }
}

@main
struct AmbraWidgets: WidgetBundle {
  var body: some Widget {
    DownloadActivityWidget()
  }
}

/// The share of songs saved, with the one being saved counted as half done so the ring moves at once.
private func fraction(_ state: DownloadActivityAttributes.ContentState) -> Double {
  guard state.total > 0 else { return 0 }
  if state.finished { return 1 }
  return min(1, (Double(state.done) + 0.5) / Double(state.total))
}

private func count(_ state: DownloadActivityAttributes.ContentState) -> String {
  state.finished ? "Saved" : "\(min(state.done + 1, state.total)) of \(state.total)"
}

/// Ambra's check, or a ring filling as songs are saved.
private struct Progress: View {
  let state: DownloadActivityAttributes.ContentState
  let size: CGFloat

  var body: some View {
    ZStack {
      if state.finished {
        Circle().fill(Color.white)
        Image(systemName: "checkmark")
          .font(.system(size: size * 0.48, weight: .bold))
          .foregroundStyle(Color.black)
      } else {
        Circle().stroke(Color.white.opacity(0.18), lineWidth: size * 0.14)
        Circle()
          .trim(from: 0, to: fraction(state))
          .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.14, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
    }
    .frame(width: size, height: size)
  }
}

struct DownloadActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
      // The Lock Screen and the banner on phones without an island.
      HStack(spacing: 14) {
        Progress(state: context.state, size: 30)
        VStack(alignment: .leading, spacing: 2) {
          Text(context.state.finished ? "Downloads saved" : "Downloading")
            .font(.system(size: 15, weight: .semibold))
          if let title = context.state.title, !context.state.finished {
            Text(title).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        Text(count(context.state))
          .font(.system(size: 13, weight: .semibold).monospacedDigit())
          .foregroundStyle(.secondary)
      }
      .padding(16)
      .activityBackgroundTint(Color.black)
      .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Progress(state: context.state, size: 28).padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(count(context.state))
            .font(.system(size: 14, weight: .semibold).monospacedDigit())
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if let title = context.state.title, !context.state.finished {
            Text(title).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      } compactLeading: {
        Progress(state: context.state, size: 16)
      } compactTrailing: {
        Text(count(context.state))
          .font(.system(size: 12, weight: .semibold).monospacedDigit())
      } minimal: {
        Progress(state: context.state, size: 16)
      }
      .keylineTint(Color.white)
    }
  }
}

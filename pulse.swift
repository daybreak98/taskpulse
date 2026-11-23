// TaskPulse 悬浮小窗 —— 两级视图：标签页组 → 组内任务
// 编译：swiftc -O pulse.swift -o TaskPulse

import AppKit
import Foundation

/// 后台服务的端口跟 poller 共用 ~/.taskpulse/config.json，没配就用 8899
func taskPulsePort() -> Int {
    let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".taskpulse/config.json")
    guard let data = try? Data(contentsOf: path),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ui = obj["ui"] as? [String: Any],
          let port = ui["port"] as? Int else { return 8899 }
    return port
}

let endpoint = "http://127.0.0.1:\(taskPulsePort())"

/// 行为日志：追加到 /tmp/taskpulse-drag.log，用来排查交互问题
func dbg(_ s: String) {
    let path = "/tmp/taskpulse-drag.log"
    if !FileManager.default.fileExists(atPath: path) {
        FileManager.default.createFile(atPath: path, contents: nil)
    }
    guard let h = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) else { return }
    h.seekToEndOfFile()
    h.write("(\(Int(Date().timeIntervalSince1970 * 1000))) \(s)\n".data(using: .utf8)!)
    try? h.close()
}

let CARD_W: CGFloat = 240
let GROUP_ROW_H: CGFloat = 26
let TASK_ROW_H: CGFloat = 28
let HEADER_H: CGFloat = 28
let COMPACT_W: CGFloat = 44
/// 收起态三段计数胶囊的总高（与原来三个徽章占的高度一致）
let COMPACT_CAPSULE_H: CGFloat = 72
let EDGE_SNAP: CGFloat = 26
let ANIM = 0.06

struct TaskItem: Decodable, Equatable {
    let id: Int
    let name: String
    let group: String?
    let status: String
    /// 「已查看」任务原来是哪种状态（running/attention/stuck）
    let prev: String?
    let progress: Double
    let elapsed: Int
    let idle_minutes: Int
    let overdue: Bool
    /// agent 停下但这一轮是被限流打断的（不是交付），按卡住标红
    let failed: Bool?
    let muted: Bool?
    let stale: Bool?
    let reply_version: String?
}
struct Counts: Decodable, Equatable {
    let running: Int
    let stuck: Int
    let attention: Int
    let done: Int
}
struct Payload: Decodable {
    let updated: Int?
    let window_limit: Int?
    let poller_error: String?
    let stale_after_seconds: Double?
    let stale_count: Int?
    let event_run: Int?
    let events: [NoticeEvent]?
    let tasks: [TaskItem]
    let active: [TaskItem]
    let all: [TaskItem]
    let counts: Counts
}

/// 后端推过来的提示事件（卡住 / 疑似限流 / 超时）：App 自己弹提示条，点了直接跳会话。
struct NoticeEvent: Decodable {
    let seq: Int
    let title: String
    let body: String
    let cid: String?
}

func rgb(_ value: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255, alpha: alpha)
}

// ── 冷蓝灰磨砂皮肤 ────────────────────────────────────────────────
// 色值与图层顺序取自 AgentPulse-glass 参考：底板 --glass-rgb 51 77 95，
// --glass-transparency .10（即底板不透明度 90%），再叠一层高光渐变与 20px 背后的模糊。

let glassRGB: UInt32 = 0x334D5F
let glassTransparency: CGFloat = 0.10
let glassRadius: CGFloat = 16
/// 面板/提示条的边框与内高光（参考里的 --glass-border 与 inset shadow）
let glassBorder = rgb(0xD2E8F4, alpha: 0.49)
let glassInset = rgb(0xE7F7FF, alpha: 0.21)
/// 分隔线（--line #d5effc42）
let hairline = rgb(0xD5EFFC, alpha: 0.26)

let palette: [String: NSColor] = [
    "running": rgb(0x66A7CC),
    "attention": rgb(0xD6B675),
    "stuck": rgb(0xDF9A9D),
    "seen": rgb(0x8EA5B3),
    "done": rgb(0x64BC9D),
]
/// 计数胶囊里「0」用的低饱和色（参考的 --pulse-blue-zero / --pulse-zero）
let paletteZero: [String: NSColor] = ["running": rgb(0x8EABBD), "zero": rgb(0x8EA5B3)]
/// 胶囊数字的墨色
let countInk = rgb(0x142B3A)

let panelTint = rgb(glassRGB, alpha: 1 - glassTransparency)
let toastTint = rgb(glassRGB, alpha: 1 - glassTransparency)
let mainText = rgb(0xF6FBFF)
let secondaryText = rgb(0xC2CEE0)

/// 行底色按状态：蓝=运行、琥珀=待处理、珊瑚=阻塞、青绿=完成、灰蓝=未知
func rowTint(_ status: String?) -> NSColor {
    switch status {
    case "running": return rgb(0x4D9ACF, alpha: 0.33)
    case "attention": return rgb(0xCDA766, alpha: 0.33)
    case "stuck": return rgb(0xD97E8A, alpha: 0.34)
    case "done": return rgb(0x64BC9D, alpha: 0.27)
    default: return rgb(0xAEBDCA, alpha: 0.23)
    }
}

/// 一行底色：状态色 + 顶部一层极淡的高光（参考里的 linear-gradient(174deg, …)）
func drawRowPlate(_ path: NSBezierPath, _ status: String?) {
    rowTint(status).setFill()
    path.fill()
    NSGraphicsContext.saveGraphicsState()
    path.setClip()
    if let g = NSGradient(starting: rgb(0xE3F5FF, alpha: 0.07),
                          ending: rgb(0xE3F5FF, alpha: 0.0)) {
        g.draw(in: NSRect(x: path.bounds.minX, y: path.bounds.minY,
                          width: path.bounds.width, height: path.bounds.height * 0.72),
               angle: -90)
    }
    NSGraphicsContext.restoreGraphicsState()
    rgb(0xD8F1FC, alpha: 0.16).setStroke()
    path.lineWidth = 0.5
    path.stroke()
}
// 越靠前越严重
let severity: [String: Int] = ["stuck": 3, "attention": 2, "running": 1, "seen": 0, "done": 0]

struct GroupVM {
    let name: String
    let tasks: [TaskItem]
    let worst: String
    let open: Int
    let progress: Double
}

func middleEllipsis(_ s: String, maxWidth: CGFloat, attrs: [NSAttributedString.Key: Any]) -> String {
    let chars = Array(s)
    var best = "…"
    var lo = 1, hi = chars.count
    while lo <= hi {
        let keep = (lo + hi) / 2
        let headN = max(1, Int((Double(keep) * 0.7).rounded()))
        let tailN = keep - headN
        var cand = String(chars.prefix(headN))
        if tailN > 0 { cand += "…" + String(chars.suffix(tailN)) }
        if (cand as NSString).size(withAttributes: attrs).width <= maxWidth {
            best = cand
            lo = keep + 1
        } else {
            hi = keep - 1
        }
    }
    return best
}

func makeGroups(_ items: [TaskItem]) -> [GroupVM] {
    var buckets: [String: [TaskItem]] = [:]
    for t in items {
        let key = (t.group?.isEmpty == false) ? t.group! : "未分组"
        buckets[key, default: []].append(t)
    }
    var out: [GroupVM] = []
    for (name, tasks) in buckets {
        let confirmed = tasks.filter { $0.stale != true || $0.status == "attention" }
        let worst = confirmed.max { (severity[$0.status] ?? 0) < (severity[$1.status] ?? 0) }?.status ?? "seen"
        let open = confirmed.filter { (severity[$0.status] ?? 0) > 0 }.count
        let prog = tasks.isEmpty ? 0 : tasks.reduce(0.0) { $0 + $1.progress } / Double(tasks.count)
        out.append(GroupVM(name: name, tasks: tasks, worst: worst, open: open, progress: prog))
    }
    return out.sorted { a, b in
        let sa = severity[a.worst] ?? 0, sb = severity[b.worst] ?? 0
        if sa != sb { return sa > sb }
        return a.name < b.name
    }
}

// MARK: - 计数胶囊（可点击筛选）

/// 参考皮肤的 2 / 1 / 0 胶囊：一整条圆角药丸，按段上色，数字用深墨色。
/// 收起态竖着排（贴屏幕边缘的细条），展开态横着排在标题行里；点某一段按该状态筛选。
final class CapsuleView: NSView {
    /// 每段：(状态 key, 数值)，数值 nil 表示取数不可用
    var segments: [(key: String, value: Int?)] = [] { didSet { needsDisplay = true } }
    var vertical = true { didSet { needsDisplay = true } }
    /// 正在按哪个状态筛选（该段描边加亮）
    var activeKind: String? { didSet { needsDisplay = true } }
    var onPick: ((String) -> Void)?

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        onPick == nil ? nil : super.hitTest(point)
    }

    private func segmentRect(_ i: Int) -> NSRect {
        let n = max(1, segments.count)
        let h = bounds.height / CGFloat(n)
        let w = bounds.width / CGFloat(n)
        return vertical ? NSRect(x: 0, y: CGFloat(i) * h, width: bounds.width, height: h)
                        : NSRect(x: CGFloat(i) * w, y: 0, width: w, height: bounds.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !segments.isEmpty else { return }

        // 外框是深蓝灰圆角矩形，色块缩在里面——不做成整条椭圆，
        // 这样竖排时像「一节电池」，横排时像参考里那条药丸。
        let pad: CGFloat = vertical ? 3.5 : 2
        let outerRadius: CGFloat = vertical ? 13 : 9
        let shellRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let shell = NSBezierPath(roundedRect: shellRect, xRadius: outerRadius, yRadius: outerRadius)
        rgb(0x435B6C, alpha: 0.96).setFill()
        shell.fill()

        // 内圈：状态色块都画在这一块里，自动获得圆角
        let innerRect = bounds.insetBy(dx: pad, dy: pad)
        let innerRadius = max(2, outerRadius - pad)
        let inner = NSBezierPath(roundedRect: innerRect, xRadius: innerRadius, yRadius: innerRadius)

        NSGraphicsContext.saveGraphicsState()
        inner.setClip()
        let n = max(1, segments.count)
        let cellH = innerRect.height / CGFloat(n)
        let cellW = innerRect.width / CGFloat(n)
        for (i, seg) in segments.enumerated() {
            let cell = vertical
                ? NSRect(x: innerRect.minX, y: innerRect.minY + CGFloat(i) * cellH,
                         width: innerRect.width, height: cellH)
                : NSRect(x: innerRect.minX + CGFloat(i) * cellW, y: innerRect.minY,
                         width: cellW, height: innerRect.height)
            let zero = (seg.value ?? 0) == 0
            let base = (zero ? paletteZero[seg.key] : palette[seg.key]) ?? paletteZero["zero"]!
            base.setFill()
            NSBezierPath(rect: cell).fill()
            // 每格一层柔光，做出玻璃泡的厚度
            if let g = NSGradient(starting: rgb(0xFFFFFF, alpha: 0.18),
                                  ending: rgb(0x20475B, alpha: 0.12)) {
                g.draw(in: cell, angle: vertical ? 90 : -90)
            }
            if i > 0 {
                rgb(0xD7EAF3, alpha: 0.20).setFill()
                if vertical {
                    NSBezierPath(rect: NSRect(x: cell.minX, y: cell.minY, width: cell.width, height: 0.75)).fill()
                } else {
                    NSBezierPath(rect: NSRect(x: cell.minX, y: cell.minY, width: 0.75, height: cell.height)).fill()
                }
            }
            let text = seg.value.map { String($0) } ?? "–"
            let fontSize: CGFloat = vertical ? 14 : 10.5
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: fontSize, weight: .bold),
                .foregroundColor: countInk,
            ]
            let size = (text as NSString).size(withAttributes: attrs)
            (text as NSString).draw(at: NSPoint(x: cell.midX - size.width / 2,
                                                y: cell.midY - size.height / 2),
                                    withAttributes: attrs)
        }
        NSGraphicsContext.restoreGraphicsState()

        // 色块外的一圈细亮边 + 外框描边
        rgb(0xD6EBF5, alpha: 0.38).setStroke()
        inner.lineWidth = 0.75
        inner.stroke()
        rgb(0xBBD5E4, alpha: 0.40).setStroke()
        shell.lineWidth = 0.75
        shell.stroke()

        // 选中的那一段加一圈内亮边
        if let kind = activeKind, let i = segments.firstIndex(where: { $0.key == kind }) {
            let cell = (vertical
                ? NSRect(x: innerRect.minX, y: innerRect.minY + CGFloat(i) * cellH,
                         width: innerRect.width, height: cellH)
                : NSRect(x: innerRect.minX + CGFloat(i) * cellW, y: innerRect.minY,
                         width: cellW, height: innerRect.height)).insetBy(dx: 1, dy: 1)
            let path = NSBezierPath(roundedRect: cell, xRadius: 6, yRadius: 6)
            rgb(0xF1FBFF, alpha: 0.75).setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 1, let onPick else { return }
        let p = convert(event.locationInWindow, from: nil)
        for (i, seg) in segments.enumerated() where segmentRect(i).contains(p) {
            onPick(seg.key)
            return
        }
        if let first = segments.first { onPick(first.key) }
    }

    /// 非激活面板上首次点击也要能响应
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - 图钉按钮

final class PinView: NSView {
    var pinned = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let c = pinned
            ? palette["attention"]!
            : secondaryText.withAlphaComponent(0.75)
        let cx = bounds.midX, cy = bounds.midY

        let head = NSBezierPath(ovalIn: NSRect(x: cx - 3.2, y: cy - 5, width: 6.4, height: 6.4))
        let stem = NSBezierPath()
        stem.move(to: NSPoint(x: cx, y: cy + 1.2))
        stem.line(to: NSPoint(x: cx, y: cy + 4.6))
        stem.lineWidth = 1.3
        stem.lineCapStyle = .round

        if pinned {
            c.setFill(); head.fill()
            c.setStroke(); stem.stroke()
        } else {
            head.lineWidth = 1.2; c.setStroke(); head.stroke()
            stem.stroke()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 1 else { return }
        onClick?()
    }
}

// MARK: - 组行

final class GroupRowView: NSView {
    let vm: GroupVM
    var expanded: Bool = false
    var onToggle: ((GroupVM) -> Void)?
    private var hovered = false

    init(vm: GroupVM, width: CGFloat, expanded: Bool) {
        self.vm = vm
        self.expanded = expanded
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: GROUP_ROW_H))
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width
        let color = palette[vm.worst] ?? .gray

        if hovered {
            rgb(0xC5DCFF, alpha: 0.10).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 6, dy: 1.5), xRadius: 7, yRadius: 7).fill()
        }

        // 展开箭头（参考里 .chevron 的细线条，不用实心三角）
        let cx: CGFloat = 12, cy = GROUP_ROW_H / 2
        let chevron = NSBezierPath()
        chevron.lineWidth = 1.3
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        if expanded {
            chevron.move(to: NSPoint(x: cx - 3, y: cy + 1))
            chevron.line(to: NSPoint(x: cx, y: cy - 2))
            chevron.line(to: NSPoint(x: cx + 3, y: cy + 1))
        } else {
            chevron.move(to: NSPoint(x: cx - 1.5, y: cy + 3))
            chevron.line(to: NSPoint(x: cx + 1.5, y: cy))
            chevron.line(to: NSPoint(x: cx - 1.5, y: cy - 3))
        }
        secondaryText.withAlphaComponent(vm.open > 0 ? 0.85 : 0.5).setStroke()
        chevron.stroke()

        // 组名 + 会话数（参考的 h3 样式：粗体标题 + 淡色计数）
        let name = vm.name.count > 10 ? String(vm.name.prefix(10)) + "…" : vm.name
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: mainText.withAlphaComponent(vm.open > 0 ? 0.95 : 0.55),
        ]
        let nameSize = (name as NSString).size(withAttributes: attrs)
        (name as NSString).draw(at: NSPoint(x: 21, y: (GROUP_ROW_H - nameSize.height) / 2), withAttributes: attrs)

        let countText = "\(vm.tasks.count) 个会话"
        let cAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .regular),
            .foregroundColor: secondaryText.withAlphaComponent(0.75),
        ]
        let cw = (countText as NSString).size(withAttributes: cAttrs).width
        (countText as NSString).draw(at: NSPoint(x: 21 + nameSize.width + 7, y: (GROUP_ROW_H - 11) / 2 + 1),
                                     withAttributes: cAttrs)

        // 未处理数（在右侧，带状态色圆点）
        let openText = "\(vm.open)"
        let oAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold),
            .foregroundColor: color.withAlphaComponent(vm.open > 0 ? 1 : 0.35),
        ]
        let ow = (openText as NSString).size(withAttributes: oAttrs).width
        (openText as NSString).draw(at: NSPoint(x: w - 14 - ow, y: (GROUP_ROW_H - 12) / 2 + 1), withAttributes: oAttrs)
        color.withAlphaComponent(vm.open > 0 ? 1 : 0.35).setFill()
        NSBezierPath(ovalIn: NSRect(x: w - 14 - ow - 8, y: GROUP_ROW_H / 2 - 2.5, width: 5, height: 5)).fill()

        // 组底部细线（参考的 --line），比进度条更贴近新皮肤
        hairline.withAlphaComponent(0.5).setFill()
        NSBezierPath(rect: NSRect(x: 21, y: GROUP_ROW_H - 0.5, width: w - 42, height: 0.5)).fill()
        let pct = CGFloat(min(max(vm.progress, 0), 1))
        if pct > 0 {
            color.withAlphaComponent(0.75).setFill()
            NSBezierPath(roundedRect: NSRect(x: 21, y: GROUP_ROW_H - 1.5, width: max((w - 42) * pct, 1.5), height: 1.5),
                         xRadius: 0.75, yRadius: 0.75).fill()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 1 else { return }
        onToggle?(vm)
    }
}

// MARK: - 任务行

final class TaskRowView: NSView {
    let item: TaskItem
    let unconfirmed: Bool
    var checked: Bool
    var onClick: ((TaskItem) -> Void)?
    var onCheck: ((TaskItem, Bool) -> Void)?
    var onDeadline: ((TaskItem, Int?) -> Void)?
    private var hovered = false

    init(item: TaskItem, width: CGFloat, checked: Bool, snapshotStale: Bool) {
        self.item = item
        self.unconfirmed = item.stale == true || (snapshotStale && (item.status == "running" || item.status == "stuck"))
        self.checked = checked
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: TASK_ROW_H))
        self.toolTip = item.name
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }

    private var checkboxRect: NSRect { NSRect(x: bounds.width - 25, y: TASK_ROW_H / 2 - 7, width: 14, height: 14) }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width
        let done = checked || item.status == "done"
        let tone = unconfirmed ? "seen" : item.status
        let color = palette[tone] ?? secondaryText
        let alpha: CGFloat = done || unconfirmed || item.status == "seen" ? 0.7 : 1

        // 一行 = 一块状态色玻璃板（参考里 .row 的 tint + 顶部高光 + 细边）
        let plate = NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 1), xRadius: 8, yRadius: 8)
        drawRowPlate(plate, tone)
        if hovered {
            rgb(0xF4FAFF, alpha: 0.10).setFill()
            plate.fill()
        }

        color.withAlphaComponent(alpha).setFill()
        NSBezierPath(ovalIn: NSRect(x: 13, y: TASK_ROW_H / 2 - 3, width: 6, height: 6)).fill()

        let meta = metaText()
        let metaAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .medium),
            .foregroundColor: item.overdue ? palette["stuck"]! : secondaryText.withAlphaComponent(0.92 * alpha),
        ]
        let metaW = (meta as NSString).size(withAttributes: metaAttrs).width
        (meta as NSString).draw(at: NSPoint(x: w - 34 - metaW, y: TASK_ROW_H / 2 - 5.5), withAttributes: metaAttrs)

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .medium),
            .foregroundColor: mainText.withAlphaComponent(alpha),
            .strikethroughStyle: done ? 1 : 0,
        ]
        var title = item.name
        let avail = w - 34 - metaW - 38
        var size = (title as NSString).size(withAttributes: attrs)
        if size.width > avail {
            title = middleEllipsis(title, maxWidth: avail, attrs: attrs)
            size = (title as NSString).size(withAttributes: attrs)
        }
        (title as NSString).draw(at: NSPoint(x: 24, y: (TASK_ROW_H - size.height) / 2), withAttributes: attrs)

        // 勾选框
        let r = checkboxRect
        let path = NSBezierPath(roundedRect: r, xRadius: 3.5, yRadius: 3.5)
        if done {
            (item.status == "done" ? palette["done"]! : color).withAlphaComponent(0.85).setStroke()
            path.lineWidth = 1.2
            path.stroke()
            let check = NSBezierPath()
            check.move(to: NSPoint(x: r.minX + 3.5, y: r.midY))
            check.line(to: NSPoint(x: r.minX + 6, y: r.maxY - 4))
            check.line(to: NSPoint(x: r.maxX - 3, y: r.minY + 4))
            check.lineWidth = 1.6
            check.lineCapStyle = .round
            (item.status == "done" ? palette["done"]! : color).setStroke()
            check.stroke()
        } else {
            rgb(0xE6F4FF, alpha: 0.32).setStroke()
            path.lineWidth = 1.1
            path.stroke()
        }

        // 进度条：贴着玻璃板下沿
        let pct = CGFloat(min(max(item.progress, 0), 1))
        if pct > 0 {
            color.withAlphaComponent(0.75 * alpha).setFill()
            NSBezierPath(roundedRect: NSRect(x: 13, y: bounds.height - 3.5, width: (w - 30) * pct, height: 1.5),
                         xRadius: 0.75, yRadius: 0.75).fill()
        }
    }

    private func metaText() -> String {
        if item.overdue { return "超时" }
        if unconfirmed { return "待确认" }
        switch item.status {
        case "stuck": return (item.failed ?? false) ? "限流" : String(format: "%d:%02d", item.elapsed / 60, item.elapsed % 60)
        case "running": return String(format: "%d:%02d", item.elapsed / 60, item.elapsed % 60)
        case "done": return "已读"
        case "seen": return "\(item.idle_minutes)m"
        default: return "\(item.idle_minutes)m"
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if checkboxRect.insetBy(dx: -4, dy: -4).contains(p) {
            checked.toggle()
            needsDisplay = true
            onCheck?(item, checked)
            return
        }
        // 单击即跳转。双击的第二次点击不再触发（clickCount==2 时直接忽略）
        if event.clickCount == 1 {
            onClick?(item)
        }
    }


    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        for (title, minutes) in [("10 分钟后要完成", 10), ("30 分钟后", 30), ("1 小时后", 60)] {
            let mi = NSMenuItem(title: title, action: #selector(pickDeadline(_:)), keyEquivalent: "")
            mi.target = self; mi.tag = minutes; menu.addItem(mi)
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "清除截止时间", action: #selector(pickDeadline(_:)), keyEquivalent: "")
        clear.target = self; clear.tag = -1; menu.addItem(clear)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
    @objc func pickDeadline(_ sender: NSMenuItem) {
        onDeadline?(item, sender.tag < 0 ? nil : sender.tag)
    }
}

// MARK: - 主视图

final class PulseView: NSView {
    var payload: Payload?
    var connectionLost = false
    var actionMessage: String?
    var showAll = false
    var compact = false
    var pinned = false
    var openGroups: Set<String> = []
    /// 头部计数胶囊的筛选态：nil = 全部显示
    var filter: String? = nil

    var onToggleAll: (() -> Void)?
    var onFilterChange: ((String?) -> Void)?
    var onTogglePin: (() -> Void)?
    var onOpen: ((TaskItem) -> Void)?
    var onCheck: ((TaskItem, Bool) -> Void)?
    var onDeadline: ((TaskItem, Int?) -> Void)?
    var onToggleGroup: ((String) -> Void)?

    override var isFlipped: Bool { true }

    var countersUnavailable: Bool {
        guard !connectionLost, let p = payload, p.poller_error == nil, let ms = p.updated, ms > 0 else { return true }
        return Date().timeIntervalSince1970 - Double(ms) / 1000 > (p.stale_after_seconds ?? 180)
    }

    var statusMessage: String? {
        if connectionLost { return "本机服务连接中断" }
        guard let p = payload else { return "正在连接本机服务…" }
        if p.poller_error != nil { return "上游取数失败，显示上次快照" }
        if p.updated == nil { return "等待首次采样…" }
        if countersUnavailable { return "取数暂未更新，显示上次快照" }
        if let actionMessage { return actionMessage }
        if let n = p.stale_count, n > 0 { return "\(n) 个会话状态待确认" }
        return nil
    }

    var statusDetail: String? {
        guard let message = statusMessage else { return nil }
        if let error = payload?.poller_error { return message + "\n" + error }
        return message
    }

    func visibleItems() -> [TaskItem] {
        guard let p = payload else { return [] }
        let base = showAll ? p.all : p.active
        guard let f = filter else { return Array(base.prefix(p.window_limit ?? 10)) }
        let hit = base.filter { it in
            if it.status == f { return it.stale != true || f == "attention" }
            // 已查看的归入它原来的状态（暗色）。但「进行中」是产能口径：
            // 只列此刻真的在跑的行，保证数字与列表一致
            if it.status == "seen" { return f != "running" && (it.prev ?? "running") == f }
            return false
        }
        return Array(hit.prefix(16))
    }

    func groups() -> [GroupVM] { makeGroups(visibleItems()) }

    /// 没有任何真实分组时退化为平铺，避免整行只写「未分组」
    var flattened: Bool {
        let gs = groups()
        return gs.count == 1 && gs[0].name == "未分组"
    }

    /// 手动展开/折叠过的组（优先级高于自动展开）
    var closedGroups: Set<String> = []

    /// 组默认只显示一行；有阻塞/待响应的组自动展开，突出需要关注的标签页
    func isOpenNamed(_ name: String) -> Bool {
        if closedGroups.contains(name) { return false }
        // 按状态筛选时，命中的组一律展开，直接看到具体任务
        if filter != nil { return true }
        if openGroups.contains(name) { return true }
        guard let g = groups().first(where: { $0.name == name }) else { return false }
        return g.worst == "stuck" || g.worst == "attention"
    }

    /// 手动展开的组显示全部任务；自动展开只显示卡住/待处理
    func tasksFor(_ g: GroupVM) -> [TaskItem] {
        if filter != nil { return g.tasks }
        if openGroups.contains(g.name) { return g.tasks }
        // 自动展开：卡住/待处理为主，进行中与已查看也一并列出（已查看是暗色）
        return g.tasks.filter { $0.status != "done" }
    }

    /// 点击头部计数：只看该状态的标签组与任务；再点一次恢复全部
    func toggleFilter(_ kind: String) {
        filter = (filter == kind) ? nil : kind
        closedGroups.removeAll()
        openGroups.removeAll()
        rebuild()
        onFilterChange?(filter)
    }

    func layoutHeight() -> CGFloat {
        if compact { return COMPACT_CAPSULE_H + 12 }
        let h0 = HEADER_H + (statusMessage == nil ? 0 : 22)
        let items = visibleItems()
        let gs = groups()
        if gs.isEmpty { return h0 + 34 }
        if flattened { return h0 + CGFloat(items.count) * TASK_ROW_H + 8 }
        var h = h0
        for g in gs {
            h += GROUP_ROW_H
            if isOpenNamed(g.name) { h += CGFloat(tasksFor(g).count) * TASK_ROW_H }
        }
        return h + 8
    }

    func contentWidth() -> CGFloat { compact ? COMPACT_W : CARD_W }

    func rebuild() {
        subviews.forEach { $0.removeFromSuperview() }
        toolTip = compact ? statusDetail : nil
        compact ? rebuildCompact() : rebuildList()
    }

    private func rebuildCompact() {
        let unavailable = countersUnavailable
        let counts = payload?.counts
        let segments = [("running", counts?.running), ("attention", counts?.attention), ("stuck", counts?.stuck)]
            .map { (key: $0.0, value: unavailable ? nil : $0.1) }

        // 三段计数块：外框是深蓝灰圆角矩形，色块缩在里面
        let capsule = CapsuleView(frame: NSRect(x: 2, y: 2, width: COMPACT_W - 4,
                                                height: layoutHeight() - 4))
        capsule.segments = segments
        capsule.vertical = true
        capsule.activeKind = filter
        capsule.toolTip = statusDetail
        capsule.onPick = { [weak self] kind in self?.toggleFilter(kind) }
        addSubview(capsule)

        if statusMessage != nil {
            let bar = NSView(frame: NSRect(x: 0, y: 0, width: COMPACT_W, height: 3))
            bar.wantsLayer = true
            bar.layer?.backgroundColor = palette["attention"]?.cgColor
            addSubview(bar)
        }
    }

    private func rebuildList() {
        let unavailable = countersUnavailable
        addHeader(counters: payload?.counts)

        let gs = groups()
        var y = HEADER_H

        if let message = statusMessage {
            let label = NSTextField(labelWithString: message)
            label.font = .systemFont(ofSize: 11, weight: .medium)
            label.textColor = palette["attention"]
            label.frame = NSRect(x: 12, y: y + 6, width: bounds.width - 24, height: 16)
            label.toolTip = statusDetail
            addSubview(label)
            y += 22
        }

        if gs.isEmpty {
            guard !unavailable else { return }
            let text: String = {
                switch filter {
                case "stuck": return "没有卡住的任务"
                case "attention": return "没有待我处理的任务"
                case "running": return "没有进行中的任务"
                default: return "没有正在跑的任务"
                }
            }()
            let label = NSTextField(labelWithString: text)
            label.font = .systemFont(ofSize: 11)
            label.textColor = secondaryText
            label.frame = NSRect(x: 12, y: y + 8, width: bounds.width - 24, height: 16)
            addSubview(label)
            return
        }

        if flattened {
            for item in gs[0].tasks {
                let t = TaskRowView(item: item, width: bounds.width, checked: item.muted == true,
                                    snapshotStale: unavailable)
                t.frame = NSRect(x: 0, y: y, width: bounds.width, height: TASK_ROW_H)
                t.onClick = { [weak self] it in self?.onOpen?(it) }
                t.onCheck = { [weak self] it, on in self?.onCheck?(it, on) }
                t.onDeadline = { [weak self] it, m in self?.onDeadline?(it, m) }
                addSubview(t)
                y += TASK_ROW_H
            }
            return
        }

        for g in gs {
            let isOpen = isOpenNamed(g.name)
            let row = GroupRowView(vm: g, width: bounds.width, expanded: isOpen)
            row.frame = NSRect(x: 0, y: y, width: bounds.width, height: GROUP_ROW_H)
            row.onToggle = { [weak self] vm in self?.toggle(group: vm.name) }
            addSubview(row)
            y += GROUP_ROW_H

            guard isOpen else { continue }
            for item in tasksFor(g) {
                let t = TaskRowView(item: item, width: bounds.width, checked: item.muted == true,
                                    snapshotStale: unavailable)
                t.frame = NSRect(x: 0, y: y, width: bounds.width, height: TASK_ROW_H)
                t.onClick = { [weak self] it in self?.onOpen?(it) }
                t.onCheck = { [weak self] it, on in self?.onCheck?(it, on) }
                t.onDeadline = { [weak self] it, m in self?.onDeadline?(it, m) }
                addSubview(t)
                y += TASK_ROW_H
            }
        }
    }

    private func toggle(group name: String) {
        if isOpenNamed(name) {
            closedGroups.insert(name)
            openGroups.remove(name)
        } else {
            openGroups.insert(name)
            closedGroups.remove(name)
        }
        onToggleGroup?(name)
    }

    private func addHeader(counters: Counts?) {
        // 计数胶囊：横排三段，占原来三个徽章的位置；点哪段就按该状态筛选
        if let c = counters {
            let capH: CGFloat = 18
            let capW: CGFloat = 78
            let cap = CapsuleView(frame: NSRect(x: 10, y: (HEADER_H - capH) / 2,
                                                width: capW, height: capH))
            cap.segments = [("running", countersUnavailable ? nil : c.running),
                            ("attention", countersUnavailable ? nil : c.attention),
                            ("stuck", countersUnavailable ? nil : c.stuck)]
            cap.vertical = false
            cap.activeKind = filter
            cap.toolTip = filter == nil ? "点数字只看该类任务" : "再点一次显示全部"
            cap.onPick = { [weak self] kind in self?.toggleFilter(kind) }
            addSubview(cap)
        }

        let chevron = NSTextField(labelWithString: showAll ? "⌃" : "⌄")
        chevron.font = .systemFont(ofSize: 11, weight: .semibold)
        chevron.textColor = secondaryText.withAlphaComponent(0.75)
        chevron.alignment = .center
        chevron.frame = NSRect(x: bounds.width - 24, y: 6, width: 14, height: 14)
        addSubview(chevron)

        let pin = PinView(frame: NSRect(x: bounds.width - 48, y: (HEADER_H - 18) / 2, width: 18, height: 18))
        pin.pinned = pinned
        pin.toolTip = pinned ? "已固定展开（点击取消）" : "固定展开"
        pin.onClick = { [weak self] in self?.onTogglePin?() }
        addSubview(pin)

        let sep = NSView(frame: NSRect(x: 10, y: HEADER_H - 0.5, width: bounds.width - 20, height: 0.5))
        sep.wantsLayer = true
        sep.layer?.backgroundColor = hairline.cgColor
        addSubview(sep)
    }

    // 自绘拖拽：不用系统窗口拖动会话
    var onDragStart: (() -> Void)?
    var onDragEnd: (() -> Void)?
    private var dragStartScreen: NSPoint?
    private var dragWinOrigin: NSPoint = .zero

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let headerH = compact ? layoutHeight() : HEADER_H
        if event.clickCount == 2 && p.y <= headerH {
            onToggleAll?()
            return
        }
        if let win = window {
            // 屏幕坐标做基准：窗口移动后 locationInWindow 会跟着变
            dragStartScreen = NSEvent.mouseLocation
            dragWinOrigin = win.frame.origin
            onDragStart?()
        }
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStartScreen, let win = window else { return }
        let now = NSEvent.mouseLocation
        win.setFrameOrigin(NSPoint(x: dragWinOrigin.x + (now.x - start.x),
                                   y: dragWinOrigin.y + (now.y - start.y)))
    }

    override func mouseUp(with event: NSEvent) {
        guard dragStartScreen != nil else { return }
        dragStartScreen = nil
        onDragEnd?()
    }

    /// 兜底收尾（轮询发现鼠标已松开）时调用
    func stopTracking() { dragStartScreen = nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// 文字/装饰不拦鼠标，拖拽从任意位置都能起手
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let v = super.hitTest(point) else { return nil }
        if v is NSTextField { return self }
        return v
    }
}

// MARK: - 可点击的提示条（Agent 回话）

final class ToastView: NSView {
    var title = ""
    var body = ""
    var accent: NSColor = .systemBlue
    /// 点击瞬间的高亮反馈
    var highlighted = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                 xRadius: glassRadius, yRadius: glassRadius)
        // 和主面板同一套底板：磨砂层由外层 NSVisualEffectView 提供，这里只叠蒙层 + 高光
        toastTint.setFill()
        shape.fill()
        NSGraphicsContext.saveGraphicsState()
        shape.setClip()
        if let g = NSGradient(starting: rgb(0xCBE3F1, alpha: 0.16),
                              ending: rgb(0xCBE3F1, alpha: 0.0)) {
            g.draw(in: NSRect(x: 0, y: bounds.height * 0.45,
                              width: bounds.width, height: bounds.height * 0.55), angle: -90)
        }
        NSGraphicsContext.restoreGraphicsState()

        glassBorder.setStroke()
        shape.lineWidth = 1
        shape.stroke()

        if highlighted {
            rgb(0xF4FAFF, alpha: 0.14).setFill()
            shape.fill()
        }

        // 左侧强调条：按事件类型给色（卡住/限流=珊瑚、其它=琥珀）
        accent.withAlphaComponent(0.95).setFill()
        NSBezierPath(roundedRect: NSRect(x: 9, y: 12, width: 3, height: bounds.height - 24),
                     xRadius: 1.5, yRadius: 1.5).fill()

        let tAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: accent,
        ]
        (title as NSString).draw(at: NSPoint(x: 20, y: 13), withAttributes: tAttrs)

        let bAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
            .foregroundColor: mainText,
        ]
        let avail = bounds.width - 34
        let text = (self.body as NSString).size(withAttributes: bAttrs).width > avail
            ? middleEllipsis(self.body, maxWidth: avail, attrs: bAttrs)
            : self.body
        (text as NSString).draw(at: NSPoint(x: 20, y: 31), withAttributes: bAttrs)

        let hint = "点我跳转" as NSString
        let hAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5),
            .foregroundColor: secondaryText.withAlphaComponent(0.85),
        ]
        let hs = hint.size(withAttributes: hAttrs)
        hint.draw(at: NSPoint(x: bounds.width - hs.width - 14, y: bounds.height - 17), withAttributes: hAttrs)
    }

    override func mouseDown(with event: NSEvent) {
        dbg("toast mouseDown")
        onClick?()
    }
}

/// 无边框面板默认 canBecomeKey = false，点击时系统会把它当成一次「激活点击」吞掉。
/// 这里放开 canBecomeKey（配合 .nonactivatingPanel，不会把整个 App 拉到前台）。
final class ToastPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class ToastHandle {
    let panel: NSPanel
    let item: TaskItem
    var timer: Timer?
    init(panel: NSPanel, item: TaskItem) {
        self.panel = panel
        self.item = item
    }
}

// MARK: - 应用

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var panel: NSPanel!
    var view: PulseView!
    var dataTimer: Timer?
    var dataRequestInFlight = false
    var consecutiveReadFailures = 0
    var nextReadAt: TimeInterval = 0
    var drawnStatusDetail: String?
    var hoverTimer: Timer?
    var dragTimer: Timer?
    var dragging = false
    var expanded = false
    var lastNear: TimeInterval = 0
    var applying = false
    /// 收起后必须先让鼠标离开窗口，再从外面移入，才允许自动展开
    var hoverArmed = true
    var wasInside = false
    var lastCollapse: TimeInterval = 0
    /// 拖动开始前是不是收起的细条
    var wasCompactAtDragStart = false
    /// 边缘吸附已移除：macOS 自己会把窗口挪到边/居中，我们不再对抗，只记录日志
    /// 最近一次由代码自己 setFrame 的时刻，用来区分「系统回声」和真实拖动
    var lastSelfFrame: TimeInterval = 0
    var lastMoveLog: TimeInterval = 0
    /// Agent 回话提示条（最新在前，往下重叠堆叠）
    var toasts: [ToastHandle] = []
    var lastStatus: [Int: TaskItem] = [:]
    var statusSeeded = false
    /// 提示事件的游标：后端重启（event_run 变化）时只记基准，不补弹历史
    var eventRun = 0
    var lastEventSeq = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        applyLayout()
        refresh()
        dataTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        dataTimer?.tolerance = 0.2
        let ht = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in self?.hoverTick() }
        hoverTimer = ht
        RunLoop.main.add(ht, forMode: .common)
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                              object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            dbg("screenParams f=\(self.panel.frame) screens=\(NSScreen.screens.map { "\($0.frame)" })")
        }
        // 松手事件优先于轮询，尽快收缩
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] e in
            self?.endDrag("mouseUp")
            return e
        }
    }

    func buildPanel() {
        let d = UserDefaults.standard
        let vf = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let saved = savedAnchor()
        let pinnedStart = d.bool(forKey: "pinned")
        let w0: CGFloat = pinnedStart ? CARD_W : COMPACT_W
        let h0: CGFloat = pinnedStart ? 132 : 84
        let top = saved?.y ?? (vf.maxY - 22)

        // 记住上次贴的是哪条边，重启后按同一条边对齐（不再沿用展开态的 x）
        let side = d.string(forKey: "anchorSide") ?? "right"
        var left = saved?.x ?? (vf.maxX - w0 - 4)
        if side == "right" {
            left = vf.maxX - w0
        } else if side == "left" {
            left = vf.minX
        }

        panel = NSPanel(contentRect: NSRect(x: left, y: top - h0, width: w0, height: h0),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // 自己实现拖动：系统的拖动会话会在松手后回写窗口位置、延迟尺寸变更
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.delegate = self

        // 冷蓝灰磨砂底板：背后实时模糊 + 90% 底板（参考的 --glass-transparency .10）
        // + 一层高光渐变 + 细描边 + 内高光，四层叠出「玻璃」而不是「灰块」。
        let bg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: w0, height: h0))
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.appearance = NSAppearance(named: .darkAqua)
        bg.wantsLayer = true
        bg.layer?.cornerRadius = glassRadius
        bg.layer?.masksToBounds = true
        bg.layer?.borderWidth = 1
        bg.layer?.borderColor = glassBorder.cgColor
        panel.contentView = bg

        let tint = NSView(frame: bg.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = panelTint.cgColor
        tint.autoresizingMask = [.width, .height]
        // 两层高光：左上角一团柔光（参考的 radial-gradient）+ 斜向渐变，
        // 再压一条顶部 1px 亮边当作玻璃厚度。
        let glow = CAGradientLayer()
        glow.type = .radial
        glow.frame = tint.bounds
        glow.startPoint = CGPoint(x: 0.9, y: 1.0)
        glow.endPoint = CGPoint(x: 0.2, y: 0.1)
        glow.colors = [rgb(0xCBE3F1, alpha: 0.17).cgColor,
                       rgb(0xCBE3F1, alpha: 0.0).cgColor]
        glow.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        tint.layer?.addSublayer(glow)

        let sheen = CAGradientLayer()
        sheen.frame = tint.bounds
        sheen.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        sheen.colors = [rgb(0xB6D6E5, alpha: 0.10).cgColor,
                        rgb(0x8FB6CE, alpha: 0.02).cgColor,
                        rgb(0x9DC1D0, alpha: 0.11).cgColor]
        sheen.locations = [0, 0.62, 1]
        sheen.startPoint = CGPoint(x: 0.15, y: 1.0)
        sheen.endPoint = CGPoint(x: 0.85, y: 0.0)
        tint.layer?.addSublayer(sheen)

        let edge = CAGradientLayer()
        edge.frame = tint.bounds
        edge.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        edge.colors = [glassInset.cgColor, rgb(0xE7F7FF, alpha: 0.0).cgColor]
        edge.startPoint = CGPoint(x: 0.5, y: 1.0)
        edge.endPoint = CGPoint(x: 0.5, y: 0.94)
        tint.layer?.addSublayer(edge)
        bg.addSubview(tint)

        view = PulseView(frame: bg.bounds)
        view.pinned = d.bool(forKey: "pinned")
        expanded = view.pinned
        view.compact = !expanded
        view.onToggleAll = { [weak self] in self?.toggleAll() }
        view.onTogglePin = { [weak self] in self?.togglePin() }
        view.onOpen = { [weak self] item in self?.open(item) }
        view.onCheck = { [weak self] item, on in on ? self?.ack(item) : self?.unack(item) }
        view.onDeadline = { [weak self] item, m in self?.setDeadline(item, minutes: m) }
        view.onDragStart = { [weak self] in self?.dragBegan() }
        view.onDragEnd = { [weak self] in self?.endDrag("mouseUp") }
        view.onToggleGroup = { [weak self] _ in self?.applyLayout() }
        view.onFilterChange = { [weak self] _ in self?.applyLayout() }
        bg.addSubview(view)
        panel.orderFrontRegardless()
        applyLayout(force: true)
    }

    func savedAnchor() -> NSPoint? {
        let d = UserDefaults.standard
        guard d.object(forKey: "anchorX") != nil else { return nil }
        return NSPoint(x: d.double(forKey: "anchorX"), y: d.double(forKey: "anchorTop"))
    }

    func saveAnchor() {
        guard panel != nil else { return }
        let d = UserDefaults.standard
        let f = panel.frame
        let v = visibleFrame()
        d.set(f.origin.x, forKey: "anchorX")
        d.set(f.maxY, forKey: "anchorTop")
        let side = abs(f.maxX - v.maxX) <= 8 ? "right" : (abs(f.minX - v.minX) <= 8 ? "left" : "none")
        d.set(side, forKey: "anchorSide")
        d.synchronize()   // 立刻落盘，否则进程被强杀时位置会丢
    }

    /// 双击标题栏（上边缘）在「展开 / 收起」之间切换
    func toggleAll() {
        if view.compact {
            hoverArmed = true
            expanded = true
            view.compact = false
        } else {
            if view.pinned {
                view.pinned = false
                UserDefaults.standard.set(false, forKey: "pinned")
            }
            hoverArmed = false
            lastCollapse = ProcessInfo.processInfo.systemUptime
            wasInside = false
            expanded = false
            view.compact = true
        }
        applyLayout()
    }

    func togglePin() {
        view.pinned.toggle()
        UserDefaults.standard.set(view.pinned, forKey: "pinned")
        if view.pinned {
            hoverArmed = true
            expanded = true
        } else {
            expanded = panel.frame.contains(NSEvent.mouseLocation)
        }
        view.compact = !expanded
        applyLayout()
    }

    /// 鼠标进入窗口即展开、离开即收起；不做额外外扩范围
    func hoverTick() {
        guard panel != nil, !dragging, !applying else { return }
        // 按住鼠标（正在拖动/点击）时不改变窗口尺寸，避免边拖边变形
        guard !mouseHeld() else { return }

        let now = ProcessInfo.processInfo.systemUptime
        let mouse = NSEvent.mouseLocation
        let inside = panel.frame.contains(mouse)

        if inside {
            lastNear = now
            // 必须是从窗口外「移入」的那一下才展开；
            // 一直停在窗口里（贴边收起后常见）不算，避免拖完自己弹开
            if !wasInside, hoverArmed, !expanded, now - lastCollapse > 0.4 {
                expanded = true
                view.compact = false
                dbg("hover expand (enter)")
                applyLayout()
            }
        } else {
            if !view.pinned && expanded && now - lastNear > 0.15 {
                expanded = false
                view.compact = true
                hoverArmed = true
                lastCollapse = now
                applyLayout()
                wasInside = false
                return
            }
            if now - lastCollapse > 0.4 { hoverArmed = true }
        }
        wasInside = inside
    }

    /// 固定锚在主屏（origin == 0,0）。副屏位于左侧负坐标，
    /// 若跟随 panel.screen 会在跨屏边界时算错贴边位置。
    func visibleFrame() -> NSRect {
        let main = NSScreen.screens.first { $0.frame.origin == .zero }
            ?? NSScreen.main ?? NSScreen.screens.first
        return main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    func applyLayout(force: Bool = false) {
        guard panel != nil, !dragging else { return }
        let w = view.contentWidth()
        let h = max(view.layoutHeight(), 56)
        let v = visibleFrame()
        var f = panel.frame
        let touchRight = abs(f.maxX - v.maxX) <= 8
        let touchLeft = abs(f.minX - v.minX) <= 8

        var x: CGFloat
        if touchRight {
            x = v.maxX - w
        } else if touchLeft {
            x = v.minX
        } else {
            x = min(max(f.minX, v.minX), v.maxX - w)
        }
        var y = f.maxY - h
        y = min(max(y, v.minY), v.maxY - h)

        // 兜底：任何情况下都不许跑出主屏范围
        x = min(max(x, v.minX), max(v.minX, v.maxX - w))
        y = min(max(y, v.minY), max(v.minY, v.maxY - h))
        let nf = NSRect(x: x, y: y, width: w, height: h)
        if force || !sameRect(nf, f) {
            lastSelfFrame = ProcessInfo.processInfo.systemUptime
            applying = true
            panel.setFrame(nf, display: true)
            applying = false
        }
        if abs(view.frame.width - w) > 0.5 || abs(view.frame.height - h) > 0.5 {
            view.frame = NSRect(x: 0, y: 0, width: w, height: h)
        }
        // 两种形态都用同一套圆角，收起态不再拉成椭圆
        if let bg = panel.contentView {
            bg.layer?.cornerRadius = glassRadius
        }
        view.rebuild()
    }

    func sameRect(_ a: NSRect, _ b: NSRect) -> Bool {
        abs(a.minX - b.minX) < 0.5 && abs(a.minY - b.minY) < 0.5
            && abs(a.width - b.width) < 0.5 && abs(a.height - b.height) < 0.5
    }

    /// 系统拖动已不使用；若这里仍然被调用，说明有别的东西在移动窗口，留个记录
    func windowWillMove(_ notification: Notification) {
        guard ProcessInfo.processInfo.systemUptime - lastSelfFrame > 0.05 else { return }
        dbg("willMove(system) f=\(panel.frame)")
    }

    /// 开始自绘拖动：暂停布局/悬停，并起一个兜底轮询（鼠标在窗外抬起时也能收尾）
    func dragBegan() {
        dbg("dragBegin f=\(panel.frame) compact=\(view.compact)")
        dragging = true
        wasCompactAtDragStart = view.compact
        dragTimer?.invalidate()
        let t = Timer(timeInterval: 0.016, repeats: true) { [weak self] _ in
            guard let self else { return }
            if !self.mouseHeld() { self.endDrag("poll") }
        }
        dragTimer = t
        RunLoop.main.add(t, forMode: .common)
    }

    /// 松开鼠标：立刻定尺寸，不等系统拖拽会话收尾
    func endDrag(_ why: String) {
        guard dragging else { return }
        dragTimer?.invalidate()
        dragTimer = nil
        dragging = false
        view?.stopTracking()
        dbg("endDrag(\(why)) f=\(panel.frame)")
        finishDrag()
    }

    /// 比 NSEvent.pressedMouseButtons 更实时（不受事件队列滞后影响）
    func mouseHeld() -> Bool {
        CGEventSource.buttonState(.combinedSessionState, button: .left)
    }

    func finishDrag() {
        let v = visibleFrame()
        let f = panel.frame
        // 越过屏幕边缘（maxX > v.maxX 等）同样算贴边，不能用 abs 判断
        let nearRight = f.maxX >= v.maxX - EDGE_SNAP
        let nearLeft = f.minX <= v.minX + EDGE_SNAP
        let nearTop = f.maxY >= v.maxY - EDGE_SNAP
        let nearBottom = f.minY <= v.minY + EDGE_SNAP
        let nearEdge = nearRight || nearLeft || nearTop || nearBottom
        dbg("finishDrag f=\(f) v=\(v) nearEdge=\(nearEdge) R=\(nearRight) L=\(nearLeft)")

        // 贴边就地在横向收成细条，纵向保留松手时的顶端位置。
        // 不把窗口往边上挪：macOS 自己会把窗口挪到边/居中，我们不和它对抗。
        if !view.pinned && nearEdge {
            expanded = false
            view.compact = true
            hoverArmed = false
            lastCollapse = ProcessInfo.processInfo.systemUptime
            wasInside = false
            let w = COMPACT_W
            let h = max(view.layoutHeight(), 56)
            var nf = f
            nf.size = NSSize(width: w, height: h)
            if nearRight {
                nf.origin.x = v.maxX - w
            } else if nearLeft {
                nf.origin.x = v.minX
            } else {
                nf.origin.x = min(max(f.minX, v.minX), v.maxX - w)
            }
            nf.origin.y = f.maxY - h
            // 兜底：不许跑出主屏
            nf.origin.x = min(max(nf.origin.x, v.minX), max(v.minX, v.maxX - w))
            nf.origin.y = min(max(nf.origin.y, v.minY), max(v.minY, v.maxY - h))
            applying = true
            panel.setFrame(nf, display: true)
            applying = false
            view.frame = NSRect(x: 0, y: 0, width: w, height: h)
            view.rebuild()
            dbg("  compacted nf=\(nf)")
            saveAnchor()
            return
        }

        if !view.pinned {
            // 拖动不改变原有展开状态：本来是细条就保持细条
            expanded = wasCompactAtDragStart ? false : f.contains(NSEvent.mouseLocation)
            view.compact = !expanded
        }
        applyLayout(force: true)
        saveAnchor()
    }

    func windowDidMove(_ notification: Notification) {
        if dragging {
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastMoveLog > 0.25 {
                lastMoveLog = now
                dbg("didMove f=\(panel.frame)")
            }
            return
        }
        guard !applying else { return }
        dbg("didMove(nodrag) f=\(panel.frame)")
        saveAnchor()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        dbg("didChangeScreen f=\(panel.frame) screens=\(NSScreen.screens.map { "\($0.frame)" })")
    }

    /// 右上角提示条：Agent 回话时弹出，点一下直接跳到对应标签页。
    /// 多条同时到来时往下堆叠，叠压 20pt，保证每条的标题和正文都露出来。
    func showToast(_ item: TaskItem, title: String = "Agent 回话了", body: String? = nil,
                   accent: NSColor? = nil) {
        let w: CGFloat = 288, h: CGFloat = 64

        let tv = ToastView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        tv.title = title
        tv.body = body ?? item.name
        tv.accent = accent ?? palette["attention"] ?? .systemOrange

        let np = ToastPanel(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        np.level = .statusBar
        np.isOpaque = false
        np.backgroundColor = .clear
        np.hasShadow = true
        np.hidesOnDeactivate = false
        np.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // 与主面板同一套毛玻璃：背后实时模糊 + 25% 蒙层
        let tbg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        tbg.material = .hudWindow
        tbg.blendingMode = .behindWindow
        tbg.state = .active
        tbg.appearance = NSAppearance(named: .darkAqua)
        tbg.wantsLayer = true
        tbg.layer?.cornerRadius = glassRadius
        tbg.layer?.masksToBounds = true
        tv.frame = tbg.bounds
        tv.autoresizingMask = [.width, .height]
        tbg.addSubview(tv)
        np.contentView = tbg

        print("[TaskPulse] toast \(item.name)")
        dbg("toast show id=\(item.id) stack=\(toasts.count + 1)")
        let handle = ToastHandle(panel: np, item: item)
        tv.onClick = { [weak self, weak hd = handle, weak view = tv] in
            guard let self, let hd else { dbg("toast click dead ref"); return }
            dbg("toast click id=\(hd.item.id)")
            // 先给一个「点到了」的反馈，再走跳转，跳转不等待动效
            view?.highlighted = true
            self.open(hd.item)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
                self?.dismissToast(hd, tapped: true)
            }
        }

        toasts.insert(handle, at: 0)
        while toasts.count > 3 {
            let old = toasts.removeLast()
            old.timer?.invalidate()
            old.panel.orderOut(nil)
        }
        layoutToasts()

        np.alphaValue = 0
        np.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            np.animator().alphaValue = 1
        }

        handle.timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self, weak handle] _ in
            guard let self, let hd = handle else { return }
            self.dismissToast(hd)
        }
    }

    /// 最新一条在最上面，越旧越往下，叠压 20pt
    func layoutToasts() {
        let w: CGFloat = 288, h: CGFloat = 64
        let v = visibleFrame()
        let step: CGFloat = 44
        for (i, t) in toasts.enumerated() {
            let y = v.maxY - h - 14 - CGFloat(i) * step
            t.panel.setFrame(NSRect(x: v.maxX - w - 14, y: y, width: w, height: h), display: true)
        }
    }

    func dismissToast(_ h: ToastHandle, tapped: Bool = false) {
        h.timer?.invalidate()
        h.timer = nil
        toasts.removeAll { $0 === h }
        layoutToasts()
        guard tapped else {
            h.panel.orderOut(nil)
            return
        }
        // 点击反馈：轻微缩一下 + 快速淡出
        let f = h.panel.frame
        let target = NSRect(x: f.midX - f.width * 0.46, y: f.midY - f.height * 0.46,
                            width: f.width * 0.92, height: f.height * 0.92)
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.11
            h.panel.animator().alphaValue = 0
            h.panel.animator().setFrame(target, display: true)
        }, completionHandler: {
            h.panel.orderOut(nil)
            h.panel.setFrame(f, display: false)
        })
    }

    /// 同一会话的新回复也能提示，启动时已有的回复只作为基准。
    func detectReplies(_ payload: Payload) {
        if statusSeeded {
            for item in payload.all where item.status == "attention" && item.stale != true {
                let previous = lastStatus[item.id]
                let newReply = item.reply_version.map { $0 != previous?.reply_version } ?? false
                if previous?.status != "attention" || newReply {
                    showToast(item)
                }
            }
        }
        lastStatus = Dictionary(payload.all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        statusSeeded = true
    }

    /// 后端推来的提示事件（卡住 / 疑似限流 / 超时）：用自己的提示条弹，点一下直接跳会话。
    /// 之前走 osascript 的系统通知会被 macOS 记在「脚本编辑器」名下，点了只会打开编辑器。
    func detectEvents(_ payload: Payload) {
        guard let events = payload.events else { return }
        let run = payload.event_run ?? 0
        if eventRun != run {          // 后端重启过：跳过积压，别一次性把历史事件全弹出来
            eventRun = run
            lastEventSeq = events.map { $0.seq }.max() ?? 0
            return
        }
        for event in events where event.seq > lastEventSeq {
            lastEventSeq = max(lastEventSeq, event.seq)
            guard let cid = event.cid, let id = Int(cid),
                  let item = payload.all.first(where: { $0.id == id }) else { continue }
            let accent = event.title.contains("限流") || event.title.contains("卡住")
                ? palette["stuck"] : palette["attention"]
            showToast(item, title: event.title, body: event.body, accent: accent)
        }
    }

    func refresh() {
        guard !dataRequestInFlight, ProcessInfo.processInfo.systemUptime >= nextReadAt,
              let url = URL(string: endpoint + "/state") else { return }
        dataRequestInFlight = true
        var req = URLRequest(url: url)
        req.timeoutInterval = 4
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            let payload: Payload?
            if (response as? HTTPURLResponse)?.statusCode == 200, let data {
                payload = try? JSONDecoder().decode(Payload.self, from: data)
            } else {
                payload = nil
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.dataRequestInFlight = false
                let counts = self.view.payload?.counts
                let items = self.view.compact ? [] : self.view.visibleItems()
                self.view.connectionLost = payload == nil
                if let payload {
                    self.view.payload = payload
                    self.consecutiveReadFailures = 0
                    self.nextReadAt = 0
                    if !self.view.countersUnavailable { self.detectReplies(payload) }
                    self.detectEvents(payload)
                } else {
                    self.consecutiveReadFailures = min(self.consecutiveReadFailures + 1, 3)
                    self.nextReadAt = ProcessInfo.processInfo.systemUptime + Double(1 << self.consecutiveReadFailures)
                }
                let detail = self.view.statusDetail
                if detail != self.drawnStatusDetail || counts != self.view.payload?.counts
                    || (!self.view.compact && items != self.view.visibleItems()) {
                    self.drawnStatusDetail = detail
                    self.applyLayout()
                }
            }
        }.resume()
    }

    /// 立刻激活 Edge：不等 HTTP/扩展，把「应用切到前台」这段耗时压到 0
    func activateEdge() {
        NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.microsoft.edgemac")
            .first?
            .activate(options: [.activateAllWindows])
    }

    /// 点击任务行：跳到对应标签页（不再自动算完成）
    func open(_ item: TaskItem) {
        activateEdge()
        guard let url = URL(string: endpoint + "/open?id=\(item.id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        let t0 = Date()
        dbg("open req id=\(item.id)")
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            dbg("open resp id=\(item.id) code=\(code) \(ms)ms err=\(err?.localizedDescription ?? "-") body=\(body)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.refresh() }
        }.resume()
    }

    /// 勾选框：手动确认完成
    func ack(_ item: TaskItem) {
        post("/ack?id=\(item.id)")
    }

    /// 取消勾选：恢复对该会话的监控
    func unack(_ item: TaskItem) {
        post("/unack?id=\(item.id)")
    }

    func post(_ path: String) {
        guard let url = URL(string: endpoint + path) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            let result = data.flatMap { try? JSONDecoder().decode(ActionResult.self, from: $0) }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200 && result?.ok == true
            DispatchQueue.main.async {
                guard let self else { return }
                self.view.actionMessage = ok ? nil : "操作未确认，请重试"
                self.applyLayout()
                self.nextReadAt = 0
                self.refresh()
            }
        }.resume()
    }

    func setDeadline(_ item: TaskItem, minutes: Int?) {
        let duration = minutes.map { "&minutes=\($0)" } ?? ""
        post("/deadline?id=\(item.id)" + duration)
    }
}

private struct ActionResult: Decodable {
    let ok: Bool
}

// 单实例
try? FileManager.default.createDirectory(atPath: NSHomeDirectory() + "/.taskpulse",
                                         withIntermediateDirectories: true)
let lockPath = NSHomeDirectory() + "/.taskpulse/ui.lock"
if !FileManager.default.fileExists(atPath: lockPath) {
    FileManager.default.createFile(atPath: lockPath, contents: nil)
}
let appLock = try? FileHandle(forWritingTo: URL(fileURLWithPath: lockPath))
if let appLock, flock(appLock.fileDescriptor, LOCK_EX | LOCK_NB) != 0 {
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
withExtendedLifetime(appLock) { app.run() }

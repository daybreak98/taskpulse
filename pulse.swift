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

/// 本机服务的共享密钥：~/.taskpulse/token（由 poller / 安装脚本生成，权限 0600）。
/// 没有它 poller 会回 401，所以每个请求都要挂上 X-TP-Token。
enum TokenCache {
    static var signature: String?
    static var value = ""
    static var warned = false
    static let lock = NSLock()
}

/// 读密钥，按文件 (mtime, size) 缓存。
/// 为什么要缓存：/state 每秒拉一次，每次都读盘 + 解析纯属浪费；
/// 为什么用 mtime 当键：用户换钥匙（重装、手动删文件）后能立刻生效，不需要重启 App。
func taskPulseToken() -> String {
    let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".taskpulse/token")
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path.path) else {
        // 文件还不存在：按空 token 发（服务端会回 401），只记一次日志。
        // 不在这里崩、也不静默跳过请求——「发出去被拒」在界面上是明确的未授权。
        TokenCache.lock.lock()
        defer { TokenCache.lock.unlock() }
        TokenCache.signature = nil
        TokenCache.value = ""
        if !TokenCache.warned {
            TokenCache.warned = true
            dbg("token 缺失：\(path.path) 不存在，按空 token 发送（服务端会回 401）")
        }
        return ""
    }
    let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    let size = (attrs[.size] as? Int) ?? 0
    let signature = "\(mtime)-\(size)"

    TokenCache.lock.lock()
    defer { TokenCache.lock.unlock() }
    if TokenCache.signature == signature { return TokenCache.value }
    let text = ((try? String(contentsOf: path, encoding: .utf8)) ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    TokenCache.signature = signature
    TokenCache.value = text
    if text.isEmpty && !TokenCache.warned {
        TokenCache.warned = true
        dbg("token 为空：\(path.path) 内容是空的，按空 token 发送（服务端会回 401）")
    }
    return text
}

/// 给请求挂上身份头。空 token 也照样挂：让服务端明确拒绝，
/// 比在这里「悄悄不发」好排查得多。
func withToken(_ req: inout URLRequest) {
    req.setValue(taskPulseToken(), forHTTPHeaderField: "X-TP-Token")
}

/// 行为日志：追加到 ~/Library/Logs/taskpulse-app.log，用来排查交互问题
func dbg(_ s: String) {
    // 放用户日志目录：/tmp 重启就没了，用户反馈问题时也找不到。
    let dir = Bootstrap.home + "/Library/Logs"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let path = dir + "/taskpulse-app.log"
    if !FileManager.default.fileExists(atPath: path) {
        FileManager.default.createFile(atPath: path, contents: nil)
    }
    // 长期运行别把磁盘写满：超过 1MB 只留最后 200KB
    if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
       let size = attrs[.size] as? Int, size > 1_000_000,
       let data = FileManager.default.contents(atPath: path) {
        try? data.suffix(200_000).write(to: URL(fileURLWithPath: path))
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
    /// 用户手动标的「完成后提醒我」：行更亮，回话弹窗常驻
    let important: Bool?
    /// 浏览器里是否有这个会话的标签页（清理菜单据此算能关几个）
    let has_tab: Bool?
}
struct Counts: Decodable, Equatable {
    let running: Int
    let stuck: Int
    let attention: Int
    let done: Int
}
struct Payload: Decodable {
    let updated: Int?
    /// 当前取数来源："api"（本机 OBO token）或 "web"（浏览器内 cookie）
    let source: String?
    /// web 来源的缓存新鲜度（秒）
    let source_age: Double?
    let window_limit: Int?
    let poller_error: String?
    /// 凭据失效（401）：只有重新扫码能恢复，界面据此显示「扫码授权」按钮
    let auth_required: Bool?
    /// 距离下一次重试还有多少秒；null 表示没有退避在跑
    let retry_in_seconds: Int?
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

// 底色在参考 #334D5F 基础上再压两档（× 0.75 × 0.75 ≈ 0.56），透明度停在 10%。
// 想更透就改 glassTransparency（0.2 左右还能看清字，0.35 会明显发白）。
let glassRGB: UInt32 = 0x1D2C35
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
/// 计数胶囊配色：对齐参考实现（纯色底 + 中心径向高光），与行/点用的 palette 分开
struct CapsuleTone {
    let fill: NSColor
    let highlight: NSColor
}
/// 色块默认亮度与高光亮度统一的提亮倍数（1 = 原样，2 = 视觉亮度翻倍）
let capsuleBrightness: CGFloat = 1.2

/// 线性光空间里按倍数提亮：感知亮度真的翻倍，同时保住色相
/// （直接在 sRGB 上乘系数会偏色、往白里塌）
func brightened(_ color: NSColor, by factor: CGFloat) -> NSColor {
    guard let c = color.usingColorSpace(.sRGB) else { return color }
    func toLinear(_ v: CGFloat) -> CGFloat {
        v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }
    func fromLinear(_ v: CGFloat) -> CGFloat {
        let l = min(max(v, 0), 1)
        return l <= 0.0031308 ? l * 12.92 : 1.055 * pow(l, 1 / 2.4) - 0.055
    }
    return NSColor(srgbRed: fromLinear(toLinear(c.redComponent) * factor),
                   green: fromLinear(toLinear(c.greenComponent) * factor),
                   blue: fromLinear(toLinear(c.blueComponent) * factor),
                   alpha: c.alphaComponent)
}

func capsuleTone(_ fill: NSColor, _ highlight: NSColor) -> CapsuleTone {
    CapsuleTone(fill: brightened(fill, by: capsuleBrightness),
                highlight: brightened(highlight, by: capsuleBrightness)
                    .withAlphaComponent(min(1, highlight.alphaComponent * capsuleBrightness)))
}

let capsuleTones: [String: CapsuleTone] = [
    // 运行中偏蓝（色相约 211°），别被提亮带成青色；蓝相亮度天然偏低，底色配高一档
    "running": capsuleTone(rgb(0x4C83BB), rgb(0x78B2F0, alpha: 0xA8 / 255.0)),
    "attention": capsuleTone(rgb(0x9B926F), rgb(0xE5BD69, alpha: 0xCC / 255.0)),
    "stuck": capsuleTone(rgb(0xA5707A), rgb(0xEFA8AF, alpha: 0xA8 / 255.0)),
]
/// 计数为 0 时统一降到这一档，不再按状态各配一个灰
let capsuleZero = capsuleTone(rgb(0x607E90), rgb(0x9EB4C3, alpha: 0x59 / 255.0))
/// 胶囊底板 / 整圈描边 / 内圈细线 / 数字墨色
let capsuleShell = rgb(0x3A5B6D, alpha: 0.78)
let capsuleEdge = rgb(0xCDE5F2, alpha: 0.64)
let capsuleEdgeInner = rgb(0xEDF9FF, alpha: 0.13)
let countInk = rgb(0x122938)

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

/// 定时进度的高光色：深色玻璃上「压暗」几乎看不出来，改成亮一档铺开
func rowProgressGlow(_ status: String?) -> NSColor? {
    switch status {
    case "running": return rgb(0xD6EDFF)
    case "attention": return rgb(0xFFEDC9)
    case "stuck": return rgb(0xFFDEE3)
    default: return nil
    }
}

/// 一行底色：状态色 + 顶部一层极淡的高光（参考里的 linear-gradient(174deg, …)）
/// progress > 0 时，用提亮一档的同色高光从左向右铺开，整行底色本身就是定时进度条
func drawRowPlate(_ path: NSBezierPath, _ status: String?, progress: Double = 0) {
    rowTint(status).setFill()
    path.fill()
    NSGraphicsContext.saveGraphicsState()
    path.setClip()
    let pct = CGFloat(min(max(progress, 0), 1))
    if pct > 0, let glow = rowProgressGlow(status) {
        let b = path.bounds
        let bar = NSRect(x: b.minX, y: b.minY, width: b.width * pct, height: b.height)
        // 左淡右亮，但末端要淡出：直接切在进度点会形成一道竖直亮线
        if let g = NSGradient(colorsAndLocations:
            (glow.withAlphaComponent(0.15), 0.0),
            (glow.withAlphaComponent(0.30), 0.72),
            (glow.withAlphaComponent(0.30), 0.86),
            (glow.withAlphaComponent(0.0), 1.0)) {
            g.draw(in: bar, angle: 0)
        }
    }
    // 明暗扩散：左上提亮、右下压暗，斜向拉一层，避免每行像一块平涂色卡
    if let g = NSGradient(colorsAndLocations:
        (rgb(0xEAF7FF, alpha: 0.11), 0.0),
        (rgb(0xEAF7FF, alpha: 0.0), 0.48),
        (rgb(0x0B1A24, alpha: 0.16), 1.0)) {
        g.draw(in: path.bounds, angle: -55)
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
    /// 命中当前筛选的会话数（无筛选时等于 tasks.count）
    var matched: Int = 0
}

/// 会话标题来自上游，可能带换行或制表符。一行一个任务的前提必须由这里保证：
/// 带换行的字符串会被 draw(at:) 画成多行，直接压到相邻行上。
func singleLine(_ s: String) -> String {
    var out = ""
    var pendingSpace = false
    for ch in s {
        if ch.isNewline || ch == "\t" {
            pendingSpace = !out.isEmpty
        } else if ch == " " {
            pendingSpace = !out.isEmpty
        } else {
            if pendingSpace { out.append(" ") }
            pendingSpace = false
            out.append(ch)
        }
    }
    return out
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

func makeGroups(_ items: [TaskItem], matching: ((TaskItem) -> Bool)? = nil) -> [GroupVM] {
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
        let hit = matching.map { m in tasks.filter(m).count } ?? tasks.count
        out.append(GroupVM(name: name, tasks: tasks, worst: worst, open: open,
                           progress: prog, matched: hit))
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
    /// 取数异常/待确认：白边整体染成琥珀色，替代原来压在最上面的 3pt 色条
    var alerting = false { didSet { needsDisplay = true } }
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
        let n = max(1, segments.count)
        let outerRadius: CGFloat = vertical ? glassRadius : bounds.height / 2
        let pill = NSBezierPath(roundedRect: bounds, xRadius: outerRadius, yRadius: outerRadius)

        // 底板：半透明蓝灰（参考里的 capsule 背景），色块铺在上面
        capsuleShell.setFill()
        pill.fill()

        NSGraphicsContext.saveGraphicsState()
        pill.addClip()

        let cellH = bounds.height / CGFloat(n)
        let cellW = bounds.width / CGFloat(n)
        for (i, seg) in segments.enumerated() {
            let cell = vertical
                ? NSRect(x: 0, y: CGFloat(i) * cellH, width: bounds.width, height: cellH)
                : NSRect(x: CGFloat(i) * cellW, y: 0, width: cellW, height: bounds.height)
            let zero = (seg.value ?? 0) == 0
            let tone = zero ? capsuleZero : (capsuleTones[seg.key] ?? capsuleZero)
            tone.fill.setFill()
            NSBezierPath(rect: cell).fill()

            // 中心偏上的径向高光（对应参考的 radial-gradient at 52% 44%）
            // 单层受 alpha 上限限制，叠 3 层才够亮；选中的那格再叠一层
            let picked = activeKind != nil && seg.key == activeKind
            if let g = NSGradient(colorsAndLocations:
                (tone.highlight, 0.0),
                (tone.highlight.withAlphaComponent(0), 0.78)) {
                // 参考是 52% / 44%：略高于中心（视图是翻转坐标系，所以取负）
                for _ in 0..<(picked ? 4 : 3) {
                    g.draw(in: cell, relativeCenterPosition: NSPoint(x: 0.02, y: -0.06))
                }
            }

            // 选中态不画白色框：靠上面多叠的那层状态色高光区分，其余两格压暗一点
            if let kind = activeKind, seg.key != kind {
                rgb(0x0B141B, alpha: 0.22).setFill()
                NSBezierPath(rect: cell).fill()
            }

            // 分格处不画分隔线：整圈描边盖住整颗胶囊，格间不该有重复的边线
            let text = seg.value.map { String($0) } ?? "–"
            let fontSize: CGFloat = vertical ? 14 : 12
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: fontSize, weight: .semibold),
                .foregroundColor: countInk,
            ]
            let size = (text as NSString).size(withAttributes: attrs)
            (text as NSString).draw(at: NSPoint(x: cell.midX - size.width / 2,
                                                y: cell.midY - size.height / 2),
                                    withAttributes: attrs)
        }

        NSGraphicsContext.restoreGraphicsState()

        // 整圈描边压在色块上：外层 2px 亮蓝，内侧再 1px 更亮的细线
        let borderW: CGFloat = vertical ? 2 : 1
        let edge = NSBezierPath(roundedRect: bounds.insetBy(dx: borderW / 2, dy: borderW / 2),
                                xRadius: max(1, outerRadius - borderW / 2),
                                yRadius: max(1, outerRadius - borderW / 2))
        (alerting ? (capsuleTones["attention"]?.fill ?? capsuleEdge) : capsuleEdge).setStroke()
        edge.lineWidth = borderW
        edge.stroke()

        let inset = borderW + 0.5
        let innerEdge = NSBezierPath(roundedRect: bounds.insetBy(dx: inset, dy: inset),
                                     xRadius: max(1, outerRadius - inset),
                                     yRadius: max(1, outerRadius - inset))
        capsuleEdgeInner.setStroke()
        innerEdge.lineWidth = 1
        innerEdge.stroke()
    }

    /// 右键胶囊：重新跑一遍安装引导（Esc 关掉引导不会清 onboarded，这里给个入口）
    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        let item = NSMenuItem(title: "重新打开安装引导", action: #selector(reopenOnboarding), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    @objc private func reopenOnboarding() {
        OnboardingController.shared.show()
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

// MARK: - 表头空白区

/// 表头空白处（计数胶囊和 API/WEB 之间）双击：全部分组展开 / 折叠。
/// 不画任何东西、不设 tooltip、不改光标——只是接一个手势。
final class HeaderBlankCatcher: NSView {
    var onDoubleClick: (() -> Void)?

    override var isFlipped: Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onDoubleClick?()
            return
        }
        // 单击仍交给上层：表头也是拖动窗口的把手
        super.mouseDown(with: event)
    }
}

// MARK: - 图钉按钮

final class PinView: NSView {
    var pinned = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    private var hovered = false { didSet { needsDisplay = true } }
    // 诊断入口：TP_TEST_PIN=hover 时把图钉按「鼠标悬浮中」渲染，
    // 不需要注入鼠标也能核对悬浮配色
    private static let forceHover = ProcessInfo.processInfo.environment["TP_TEST_PIN"] == "hover"

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func draw(_ dirtyRect: NSRect) {
        // 只有未固定时才预览「点下去会变黄」；已固定就是黄实心，
        // 悬浮不再退回灰色描边——那看起来像被取消了，反而是误导
        let preview = pinned || hovered || PinView.forceHover
        let c = preview
            ? palette["attention"]!
            : secondaryText.withAlphaComponent(0.75)
        let cx = bounds.midX, cy = bounds.midY

        let head = NSBezierPath(ovalIn: NSRect(x: cx - 3.2, y: cy - 5, width: 6.4, height: 6.4))
        let stem = NSBezierPath()
        stem.move(to: NSPoint(x: cx, y: cy + 1.2))
        stem.line(to: NSPoint(x: cx, y: cy + 4.6))
        stem.lineWidth = 1.3
        stem.lineCapStyle = .round

        if preview {
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

// MARK: - 关闭按钮

/// 右上角的退出键：平时是暗色叉，鼠标移上来变珊瑚红——「关闭」这种破坏性操作
/// 不该跟其它按钮一样低调，但也不该常亮抢注意力。
final class CloseButton: NSView {
    var onClick: (() -> Void)?
    private var hovered = false { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func draw(_ dirtyRect: NSRect) {
        let c = hovered ? rgb(0xFF6F61) : secondaryText.withAlphaComponent(0.55)
        let inset: CGFloat = 5.5
        let path = NSBezierPath()
        path.lineWidth = 1.4
        path.lineCapStyle = .round
        path.move(to: NSPoint(x: inset, y: inset))
        path.line(to: NSPoint(x: bounds.width - inset, y: bounds.height - inset))
        path.move(to: NSPoint(x: bounds.width - inset, y: inset))
        path.line(to: NSPoint(x: inset, y: bounds.height - inset))
        c.setStroke()
        path.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 1 else { return }
        onClick?()
    }
}

// MARK: - 数据来源切换（API / WEB）

/// 两段小胶囊：左 API（本机 token 取数）、右 WEB（浏览器里用 cookie 取数）。
final class SourceToggleView: NSView {
    var source = "api" { didSet { needsDisplay = true } }
    var onPick: ((String) -> Void)?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let r = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                             xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        rgb(0x0F1A21, alpha: 0.35).setFill()
        r.fill()
        hairline.setStroke()
        r.lineWidth = 0.8
        r.stroke()

        let labels = [("api", "API"), ("web", "WEB")]
        let half = bounds.width / 2
        for (i, pair) in labels.enumerated() {
            let active = source == pair.0
            let cell = NSRect(x: CGFloat(i) * half, y: 0, width: half, height: bounds.height)
            if active {
                let pill = NSBezierPath(roundedRect: cell.insetBy(dx: 1, dy: 1),
                                        xRadius: (bounds.height - 2) / 2,
                                        yRadius: (bounds.height - 2) / 2)
                palette[pair.0 == "web" ? "done" : "running"]!.withAlphaComponent(0.85).setFill()
                pill.fill()
            }
            let text = pair.1 as NSString
            let font = NSFont.systemFont(ofSize: 8.5, weight: active ? .bold : .medium)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: active ? NSColor.white.withAlphaComponent(0.96)
                                         : secondaryText.withAlphaComponent(0.7),
            ]
            let size = text.size(withAttributes: attrs)
            text.draw(at: NSPoint(x: cell.midX - size.width / 2, y: cell.midY - size.height / 2),
                      withAttributes: attrs)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 1 else { return }
        let p = convert(event.locationInWindow, from: nil)
        onPick?(p.x < bounds.midX ? "api" : "web")
    }
}

// MARK: - 组行

final class GroupRowView: NSView {
    let vm: GroupVM
    /// 头部计数的筛选态（running/stuck/attention）；nil = 全部显示
    let highlight: String?
    var expanded: Bool = false
    var onToggle: ((GroupVM) -> Void)?
    private var hovered = false

    init(vm: GroupVM, width: CGFloat, expanded: Bool, highlight: String? = nil) {
        self.vm = vm
        self.highlight = highlight
        self.expanded = expanded
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: GROUP_ROW_H))
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width
        // 筛选态：组头的色与右侧数字都换成「被选中的那个状态」的命中情况，
        // 没命中的组整体压暗，一眼能看出它跟当前筛选无关
        let color = palette[highlight ?? vm.worst] ?? .gray
        let badge = highlight == nil ? vm.open : vm.matched

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
        secondaryText.withAlphaComponent(badge > 0 ? 0.85 : 0.5).setStroke()
        chevron.stroke()

        // 组名 + 会话数（参考的 h3 样式：粗体标题 + 淡色计数）
        let cleanName = singleLine(vm.name)
        let name = cleanName.count > 10 ? String(cleanName.prefix(10)) + "…" : cleanName
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: mainText.withAlphaComponent(badge > 0 ? 0.95 : 0.55),
        ]
        let nameSize = (name as NSString).size(withAttributes: attrs)
        (name as NSString).draw(at: NSPoint(x: 21, y: (GROUP_ROW_H - nameSize.height) / 2), withAttributes: attrs)

        let countText = highlight == nil ? "\(vm.tasks.count) 个会话" : "\(vm.matched)/\(vm.tasks.count) 个会话"
        let cAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .regular),
            .foregroundColor: secondaryText.withAlphaComponent(0.75),
        ]
        let cw = (countText as NSString).size(withAttributes: cAttrs).width
        (countText as NSString).draw(at: NSPoint(x: 21 + nameSize.width + 7, y: (GROUP_ROW_H - 11) / 2 + 1),
                                     withAttributes: cAttrs)

        // 未处理数 / 筛选命中数（在右侧，带状态色圆点）
        let openText = "\(badge)"
        let oAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold),
            .foregroundColor: color.withAlphaComponent(badge > 0 ? 1 : 0.35),
        ]
        let ow = (openText as NSString).size(withAttributes: oAttrs).width
        (openText as NSString).draw(at: NSPoint(x: w - 14 - ow, y: (GROUP_ROW_H - 12) / 2 + 1), withAttributes: oAttrs)
        color.withAlphaComponent(badge > 0 ? 1 : 0.35).setFill()
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
    /// 当前筛选没命中它：按「已查看」的暗色画，但仍列出来（组内历史/其它状态）
    let dimmed: Bool
    var checked: Bool
    var onClick: ((TaskItem) -> Void)?
    var onCheck: ((TaskItem, Bool) -> Void)?
    var onDeadline: ((TaskItem, Int?) -> Void)?
    var onImportant: ((TaskItem, Bool) -> Void)?
    /// 菜单里的「清理标签页」：给出各档位能关几个，选中后执行
    var onCloseTabCounts: (() -> [String: Int])?
    var onCloseTabs: ((String) -> Void)?
    private var hovered = false

    init(item: TaskItem, width: CGFloat, checked: Bool, snapshotStale: Bool, dimmed: Bool = false) {
        self.item = item
        self.unconfirmed = item.stale == true || (snapshotStale && (item.status == "running" || item.status == "stuck"))
        self.dimmed = dimmed
        self.checked = checked
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: TASK_ROW_H))
        self.toolTip = singleLine(item.name)
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }

    private var checkboxRect: NSRect { NSRect(x: bounds.width - 25, y: TASK_ROW_H / 2 - 7, width: 14, height: 14) }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width
        let done = checked || item.status == "done"
        let tone = (unconfirmed || dimmed) ? "seen" : item.status
        // 标了「完成后提醒我」：颜色翻倍提亮，即使在「已查看」里也一眼能认出
        let emphasized = item.important == true
        let base = palette[tone] ?? secondaryText
        let color = emphasized ? brightened(base, by: 2.0) : base
        let alpha: CGFloat = emphasized ? 1 : (done || unconfirmed || dimmed || item.status == "seen" ? 0.7 : 1)

        // 一行 = 一块状态色玻璃板（参考里 .row 的 tint + 顶部高光 + 细边）
        let plate = NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 1), xRadius: 8, yRadius: 8)
        // 定时进度画在底色里：只有运行中/待回复/卡住这三类在做倒计时
        let timed = !done && ["running", "attention", "stuck"].contains(item.status)
        drawRowPlate(plate, tone, progress: timed ? item.progress : 0)
        if hovered {
            rgb(0xF4FAFF, alpha: 0.10).setFill()
            plate.fill()
        }

        if emphasized {
            let bar = NSBezierPath(roundedRect: NSRect(x: 6, y: 5, width: 2.5, height: TASK_ROW_H - 10),
                                   xRadius: 1.25, yRadius: 1.25)
            color.withAlphaComponent(0.95).setFill()
            bar.fill()
        }
        color.withAlphaComponent(alpha).setFill()
        NSBezierPath(ovalIn: NSRect(x: 13, y: TASK_ROW_H / 2 - 3, width: 6, height: 6)).fill()

        let meta = metaText()
        let metaAttrs: [NSAttributedString.Key: Any] = [
            // 和标题同字号：一眼看名次靠时间是第几近的交互
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .medium),
            .foregroundColor: item.overdue ? palette["stuck"]! : secondaryText.withAlphaComponent(0.95 * alpha),
        ]
        let metaSize = (meta as NSString).size(withAttributes: metaAttrs)
        let metaW = metaSize.width
        // 字号和标题一致（11.5），垂直居中按实际高度算，别用固定偏移
        (meta as NSString).draw(at: NSPoint(x: w - 34 - metaW,
                                            y: (TASK_ROW_H - metaSize.height) / 2),
                                withAttributes: metaAttrs)

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .medium),
            .foregroundColor: mainText.withAlphaComponent(alpha),
            .strikethroughStyle: done ? 1 : 0,
        ]
        var title = singleLine(item.name)
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
        // 最上面一项：完成后的回话要重点提醒。选中态用暗色底标出来，
        // 再点一次即取消——和下面几项「选时间」是独立的开关。
        let toggle = NSMenuItem(title: "完成后提醒我", action: nil, keyEquivalent: "")
        let row = MenuToggleView(frame: NSRect(x: 0, y: 0, width: 200, height: 26))
        row.titled = "完成后提醒我"
        row.on = item.important == true
        row.onClick = { [weak self] in
            guard let self else { return }
            self.onImportant?(self.item, self.item.important != true)
        }
        toggle.view = row
        menu.addItem(toggle)
        menu.addItem(.separator())
        for (title, minutes) in [("10 分钟后要完成", 10), ("30 分钟后", 30), ("1 小时后", 60)] {
            let mi = NSMenuItem(title: title, action: #selector(pickDeadline(_:)), keyEquivalent: "")
            mi.target = self; mi.tag = minutes; menu.addItem(mi)
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "清除截止时间", action: #selector(pickDeadline(_:)), keyEquivalent: "")
        clear.target = self; clear.tag = -1; menu.addItem(clear)

        // 一批标签页越开越多，给个显式入口清理。四项同一级，彼此独立，
        // 都只关「没在跑」的会话——正在跑的把标签关掉就看不到中间过程了。
        menu.addItem(.separator())
        for (title, mode) in closeTabModes() {
            let n = closeTabCount(mode)
            // 标题里带上会关掉几个：这是不可撤销的操作，先让人看清影响面
            let mi = NSMenuItem(title: n > 0 ? "\(title)（\(n)）" : title,
                                action: #selector(closeTabs(_:)), keyEquivalent: "")
            mi.target = self
            mi.representedObject = mode
            mi.isEnabled = n > 0
            menu.addItem(mi)
        }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
    @objc func pickDeadline(_ sender: NSMenuItem) {
        onDeadline?(item, sender.tag < 0 ? nil : sender.tag)
    }

    /// 四个清理档位：不指定时间（只关没在工作的）/ 1 / 6 / 24 小时未更新
    private func closeTabModes() -> [(String, String)] {
        [("关闭未工作的标签页", "idle"),
         ("关闭 1 小时未查看的", "1h"),
         ("关闭 6 小时未查看的", "6h"),
         ("关闭 24 小时未查看的", "24h")]
    }

    /// 本地估算「这一档会关掉几个」，标题里带上，避免点了才发现影响面
    private func closeTabCount(_ mode: String) -> Int {
        guard let all = onCloseTabCounts?() else { return 0 }
        return all[mode] ?? 0
    }

    @objc func closeTabs(_ sender: NSMenuItem) {
        guard let mode = sender.representedObject as? String else { return }
        onCloseTabs?(mode)
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
    var onSetSource: ((String) -> Void)?
    var onQuit: (() -> Void)?
    /// 凭据失效时点「扫码重新授权」
    var onReauthorize: (() -> Void)?
    /// 刚点下去的来源：后端还没确认，先照它画，免得多等一个轮询周期
    var pendingSource: String?
    var onOpen: ((TaskItem) -> Void)?
    var onCheck: ((TaskItem, Bool) -> Void)?
    var onDeadline: ((TaskItem, Int?) -> Void)?
    var onImportant: ((TaskItem, Bool) -> Void)?
    /// 菜单里的「清理标签页」：给出各档位能关几个，选中后执行
    var onCloseTabCounts: (() -> [String: Int])?
    var onCloseTabs: ((String) -> Void)?
    var onToggleGroup: ((String) -> Void)?

    override var isFlipped: Bool { true }

    var countersUnavailable: Bool {
        guard !connectionLost, let p = payload, p.poller_error == nil, let ms = p.updated, ms > 0 else { return true }
        return Date().timeIntervalSince1970 - Double(ms) / 1000 > (p.stale_after_seconds ?? 180)
    }

    /// 凭据是否失效。诊断入口 TP_TEST_AUTH=1 可强制为真，
    /// 不用造一次真 401 就能核对黄条与按钮的排版
    private var authRequired: Bool {
        if ProcessInfo.processInfo.environment["TP_TEST_AUTH"] == "1" { return true }
        return payload?.auth_required == true
    }

    /// 有退避在跑时补一句「约 N 秒后重试」，让用户知道要不要等
    private var retrySuffix: String {
        guard let n = payload?.retry_in_seconds else { return "" }
        if n <= 0 { return "（正在重试）" }
        return "（约 \(n) 秒后重试）"
    }

    var statusMessage: String? {
        if connectionLost { return "本机服务连接中断" + retrySuffix }
        guard let p = payload else { return "正在连接本机服务…" }
        if authRequired { return "API 凭据已失效，取数已暂停" }
        if let error = p.poller_error {
            // 两种故障要分开说：接口/认证出问题，和「浏览器页面这一会儿没上报」
            if error.contains("没有上报") { return "浏览器页面暂无数据，显示上次快照" + retrySuffix }
            if error.contains("凭据服务") { return "需要打开 MyFlicker 客户端，API 模式已暂停" + retrySuffix }
            return "取数暂时失败，显示上次快照" + retrySuffix
        }
        if p.updated == nil { return "等待首次采样…" + retrySuffix }
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

    func baseItems() -> [TaskItem] {
        guard let p = payload else { return [] }
        return showAll ? p.all : p.active
    }

    /// 真·处于该状态（有色行）。「已查看」只是暗色历史，不算命中
    func isLive(_ it: TaskItem, _ f: String) -> Bool {
        it.status == f && (it.stale != true || f == "attention")
    }

    /// 筛选时列表不再裁到命中项：全部的组都要留下来，
    /// 命中与否交给行和组头去分色
    func visibleItems() -> [TaskItem] {
        let base = baseItems()
        guard filter != nil else { return Array(base.prefix(payload?.window_limit ?? 10)) }
        return base
    }

    func groups() -> [GroupVM] {
        let items = visibleItems()
        guard let f = filter else { return makeGroups(items) }
        return makeGroups(items, matching: { self.isLive($0, f) })
    }

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
        if openGroups.contains(name) { return true }
        guard let g = groups().first(where: { $0.name == name }) else { return false }
        // 筛选态：只展开真有会话处于该状态的组，其余组保持折叠但照样列出
        if filter != nil { return g.matched > 0 }
        return g.worst == "stuck" || g.worst == "attention"
    }

    /// 手动展开的组显示全部任务；自动展开只显示卡住/待处理
    func tasksFor(_ g: GroupVM) -> [TaskItem] {
        guard let f = filter else {
            if openGroups.contains(g.name) { return g.tasks }
            // 自动展开：卡住/待处理为主，进行中与已查看也一并列出（已查看是暗色）
            return g.tasks.filter { $0.status != "done" }
        }
        // 筛选态：命中的组只漏出处于该状态的会话；手动展开的空组列全部（暗色）
        let hit = g.tasks.filter { isLive($0, f) }
        return Array((hit.isEmpty ? g.tasks : hit).prefix(16))
    }

    /// 凭据失效时黄条下面那个按钮：把扫码授权流程拉起来
    @objc private func reauthorize() {
        onReauthorize?()
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
        // 凭据失效时黄条下面要放「扫码授权」按钮，多留一行
        let h0 = HEADER_H + (statusMessage == nil ? 0 : (authRequired ? 46 : 22))
        let gs = groups()
        if gs.isEmpty { return h0 + 34 }
        if flattened { return h0 + CGFloat(gs[0].tasks.count) * TASK_ROW_H + 8 }
        var h = h0
        for g in gs {
            h += GROUP_ROW_H
            if isOpenNamed(g.name) { h += CGFloat(tasksFor(g).count) * TASK_ROW_H }
        }
        return h + 8
    }

    /// 四个清理档位各自能关几个（只算浏览器里真的有标签、且没在跑、且够久没更新）
    func closeTabCounts() -> [String: Int] {
        let items = payload?.all ?? []
        func count(hours: Int?) -> Int {
            items.filter { t in
                guard t.has_tab == true else { return false }
                if t.status == "running" || t.status == "stuck" { return false }
                guard let h = hours else { return true }
                return t.idle_minutes >= h * 60
            }.count
        }
        return ["idle": count(hours: nil), "1h": count(hours: 1),
                "6h": count(hours: 6), "24h": count(hours: 24)]
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

        // 三段计数块：外框直接铺满小窗、圆角与小窗一致，
        // 否则圆角处会露出一条更亮的底板（看起来像"边角发白"）
        let capsule = CapsuleView(frame: NSRect(x: 0, y: 0, width: COMPACT_W, height: layoutHeight()))
        capsule.segments = segments
        capsule.vertical = true
        capsule.activeKind = filter
        capsule.toolTip = statusDetail
        capsule.onPick = { [weak self] kind in self?.toggleFilter(kind) }
        addSubview(capsule)

        capsule.alerting = statusMessage != nil
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
            // 只有凭据真的失效（401）才给这个按钮：日常状态一律不出现
            if authRequired {
                // 系统圆角按钮在深色玻璃上是深字，得自己指定颜色，
                // 否则看起来像「灰掉的不可点」——引导面板踩过同一个坑
                let btn = NSButton(title: "扫码重新授权", target: self,
                                    action: #selector(reauthorize))
                btn.isBordered = false
                btn.attributedTitle = NSAttributedString(string: "扫码重新授权", attributes: [
                    .foregroundColor: palette["attention"] ?? mainText,
                    .font: NSFont.systemFont(ofSize: 11.5, weight: .medium),
                    .underlineStyle: NSUnderlineStyle.single.rawValue,
                ])
                btn.toolTip = "用手机上的快手 App 扫码授权一次，之后长期可用"
                btn.frame = NSRect(x: 12, y: y + 24, width: 110, height: 18)
                addSubview(btn)
                y += 46
            } else {
                y += 22
            }
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
            // 没组的就是单独 agent 一行；筛选时没命中的行保持暗色但仍列出
            for item in gs[0].tasks {
                let t = TaskRowView(item: item, width: bounds.width, checked: item.muted == true,
                                    snapshotStale: unavailable,
                                    dimmed: filter.map { !isLive(item, $0) } ?? false)
                t.frame = NSRect(x: 0, y: y, width: bounds.width, height: TASK_ROW_H)
                t.onClick = { [weak self] it in self?.onOpen?(it) }
                t.onCheck = { [weak self] it, on in self?.onCheck?(it, on) }
                t.onDeadline = { [weak self] it, m in self?.onDeadline?(it, m) }
                t.onImportant = { [weak self] it, on in self?.onImportant?(it, on) }
                t.onCloseTabCounts = { [weak self] in self?.closeTabCounts() ?? [:] }
                t.onCloseTabs = { [weak self] mode in self?.onCloseTabs?(mode) }
                addSubview(t)
                y += TASK_ROW_H
            }
            return
        }

        for g in gs {
            let isOpen = isOpenNamed(g.name)
            let row = GroupRowView(vm: g, width: bounds.width, expanded: isOpen, highlight: filter)
            row.frame = NSRect(x: 0, y: y, width: bounds.width, height: GROUP_ROW_H)
            row.onToggle = { [weak self] vm in self?.toggle(group: vm.name) }
            addSubview(row)
            y += GROUP_ROW_H

            guard isOpen else { continue }
            for item in tasksFor(g) {
                let t = TaskRowView(item: item, width: bounds.width, checked: item.muted == true,
                                    snapshotStale: unavailable,
                                    dimmed: filter.map { !isLive(item, $0) } ?? false)
                t.frame = NSRect(x: 0, y: y, width: bounds.width, height: TASK_ROW_H)
                t.onClick = { [weak self] it in self?.onOpen?(it) }
                t.onCheck = { [weak self] it, on in self?.onCheck?(it, on) }
                t.onDeadline = { [weak self] it, m in self?.onDeadline?(it, m) }
                t.onImportant = { [weak self] it, on in self?.onImportant?(it, on) }
                t.onCloseTabCounts = { [weak self] in self?.closeTabCounts() ?? [:] }
                t.onCloseTabs = { [weak self] mode in self?.onCloseTabs?(mode) }
                addSubview(t)
                y += TASK_ROW_H
            }
        }
    }

    /// 全部分组展开 / 折叠：有任意一个展开着就全收起，否则全展开
    func toggleAllGroups() {
        let gs = groups()
        guard !gs.isEmpty else { return }
        let anyOpen = gs.contains { isOpenNamed($0.name) }
        if anyOpen {
            closedGroups = Set(gs.map { $0.name })
            openGroups.removeAll()
        } else {
            closedGroups.removeAll()
            openGroups = Set(gs.map { $0.name })
        }
        rebuild()
        onToggleGroup?("")
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
            // 高度贴到表头上下边（28pt 里留 2pt），形状与竖排一致
            let capH: CGFloat = HEADER_H - 4
            let capW: CGFloat = 96
            let cap = CapsuleView(frame: NSRect(x: 10, y: 2, width: capW, height: capH))
            cap.segments = [("running", countersUnavailable ? nil : c.running),
                            ("attention", countersUnavailable ? nil : c.attention),
                            ("stuck", countersUnavailable ? nil : c.stuck)]
            cap.vertical = false
            cap.activeKind = filter
            cap.toolTip = filter == nil ? "点数字只看该类任务" : "再点一次显示全部"
            cap.onPick = { [weak self] kind in self?.toggleFilter(kind) }
            addSubview(cap)
        }

        // 这个位置原来是个纯装饰的展开箭头；换成退出按钮，正好是窗口右上角
        let close = CloseButton(frame: NSRect(x: bounds.width - 26, y: (HEADER_H - 18) / 2,
                                              width: 18, height: 18))
        close.toolTip = "退出 TaskPulse（后台取数会一起停）"
        close.onClick = { [weak self] in self?.onQuit?() }
        addSubview(close)

        let pin = PinView(frame: NSRect(x: bounds.width - 48, y: (HEADER_H - 18) / 2, width: 18, height: 18))
        pin.pinned = pinned
        pin.toolTip = pinned ? "已固定展开（点击取消）" : "固定展开"
        pin.onClick = { [weak self] in self?.onTogglePin?() }
        addSubview(pin)

        let src = SourceToggleView(frame: NSRect(x: bounds.width - 100, y: (HEADER_H - 18) / 2,
                                                 width: 46, height: 18))
        let current = pendingSource ?? payload?.source ?? "api"
        src.source = current
        if let age = payload?.source_age {
            src.toolTip = "取数来源：\(current == "web" ? "浏览器内 cookie" : "本机 token")，缓存 \(Int(age)) 秒"
        } else {
            src.toolTip = "取数来源：\(current == "web" ? "浏览器内 cookie" : "本机 token")"
        }
        src.onPick = { [weak self] mode in
            guard let self, mode != current else { return }
            self.onSetSource?(mode)
        }
        addSubview(src)

        // 计数胶囊结束（x≈106）到来源开关起点（width-100）之间是纯空白，
        // 双击这里切换「全部分组展开 / 折叠」；视觉上不做任何改动
        let blankLeft: CGFloat = 106
        let blankRight: CGFloat = bounds.width - 100
        if blankRight - blankLeft > 24 {
            let catcher = HeaderBlankCatcher(
                frame: NSRect(x: blankLeft, y: 0, width: blankRight - blankLeft, height: HEADER_H))
            catcher.onDoubleClick = { [weak self] in self?.toggleAllGroups() }
            addSubview(catcher)
        }

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

// MARK: - 菜单里的开关行（完成后提醒我）

/// NSMenuItem 本身画不了背景色，这里用一个自绘视图代替标题：
/// 开启时铺小窗同款暗色，未开启时透明；悬停给一层浅色反馈。
final class MenuToggleView: NSView {
    var titled = ""
    var on = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    private var hovered = false { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let r = NSRect(x: 6, y: 2, width: bounds.width - 12, height: bounds.height - 4)
        let shape = NSBezierPath(roundedRect: r, xRadius: 5, yRadius: 5)
        // 菜单由系统画，浅色模式下是白底；这里必须用系统标签色（随明暗自适应），
        // 不能用小窗那套浅色文字——那会在白底上糊成一片。
        if on {
            rgb(0x0F1A21, alpha: 0.88).setFill()
            shape.fill()
        } else if hovered {
            NSColor.labelColor.withAlphaComponent(0.08).setFill()
            shape.fill()
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: on ? .semibold : .regular),
            .foregroundColor: on ? NSColor.white : NSColor.labelColor,
        ]
        let text = (on ? "✓ " : "") + titled
        let size = (text as NSString).size(withAttributes: attrs)
        (text as NSString).draw(at: NSPoint(x: 12, y: (bounds.height - size.height) / 2),
                                withAttributes: attrs)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func mouseDown(with event: NSEvent) {
        onClick?()
        enclosingMenuItem?.menu?.cancelTracking()
    }
}

// MARK: - 可点击的提示条（Agent 回话）

final class ToastView: NSView {
    var title = ""
    var body = ""
    var accent: NSColor = .systemBlue
    /// 重要会话：整块背景掺入 50% 状态色，与普通提示条区分开
    var emphasize = false { didSet { needsDisplay = true } }
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
        if emphasize {
            // 状态色只铺一半：整块盖满会压掉文字对比度
            accent.withAlphaComponent(0.5).setFill()
            shape.fill()
        }
        NSGraphicsContext.saveGraphicsState()
        shape.setClip()
        if let g = NSGradient(colorsAndLocations:
            (rgb(0xCBE3F1, alpha: 0.16), 0.0),
            (rgb(0xCBE3F1, alpha: 0.02), 0.45),
            (rgb(0x061319, alpha: 0.20), 1.0)) {
            g.draw(in: bounds, angle: -55)
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

// MARK: - 取数服务

/// 取数服务由 App 自己拉起：打开 App 就取数，退出就停。
///
/// 之前靠两个 launchd 常驻项，好处是关掉浮窗后取数还在跑，代价是
/// 「没打开也在后台跑」以及系统的后台项目提示。现在跟着 App 生命周期走。
final class PollerRunner {
    struct Runtime: Decodable {
        let uv: String
        let poller: String
        let port: Int?
        let args: [String]?
    }

    private var proc: Process?
    private var stopped = false
    private var startedByUs = false
    private var home: String { Bootstrap.home }

    func startIfNeeded() {
        guard let rt = loadRuntime() else {
            dbg("poller: 缺 runtime.json（安装未完成？），不自动启动")
            return
        }
        let port = rt.port ?? 8899
        // 端口上已经有服务（上次没退干净、或用户自己在终端跑着）：不重复拉起
        serviceAlive(port: port) { [weak self] alive in
            guard let self, !self.stopped else { return }
            if alive {
                dbg("poller: 已有服务在 127.0.0.1:\(port)，不重复启动")
                return
            }
            self.spawn(rt)
        }
    }

    /// 用首次初始化的结果启动（不读 runtime.json，避免刚写完文件的时序问题）
    func start(with plan: Bootstrap.Plan) {
        guard !stopped else { return }
        let rt = Runtime(uv: plan.uv, poller: plan.poller, port: plan.port, args: plan.args)
        serviceAlive(port: plan.port) { [weak self] alive in
            guard let self, !self.stopped else { return }
            if alive {
                dbg("poller: 已有服务在 127.0.0.1:\(plan.port)，不重复启动")
                return
            }
            self.spawn(rt)
        }
    }

    func stop() {
        stopped = true
        guard startedByUs, let p = proc, p.isRunning else { return }
        p.terminate()                      // SIGTERM
        let deadline = Date().addingTimeInterval(1.5)
        while p.isRunning && Date() < deadline { usleep(60_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        proc = nil
        dbg("poller 已停止")
    }

    // MARK: 内部

    private func loadRuntime() -> Runtime? {
        guard let data = FileManager.default.contents(atPath: home + "/.taskpulse/runtime.json") else {
            return nil
        }
        return try? JSONDecoder().decode(Runtime.self, from: data)
    }

    private func serviceAlive(port: Int, then: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/state") else { return then(false) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.2
        if let token = try? String(contentsOfFile: home + "/.taskpulse/token", encoding: .utf8) {
            req.setValue(token.trimmingCharacters(in: .whitespacesAndNewlines),
                         forHTTPHeaderField: "X-TP-Token")
        }
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            // 401 也算「有人在监听」，只要不是连接失败
            let alive = (resp as? HTTPURLResponse) != nil
            DispatchQueue.main.async { then(alive) }
        }.resume()
    }

    private func spawn(_ rt: Runtime) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: rt.uv)
        var args = ["run", "--quiet", "--python", ">=3.10"]
        args.append(contentsOf: rt.args ?? [])
        args.append(rt.poller)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: (rt.poller as NSString).deletingLastPathComponent)
        var env = ProcessInfo.processInfo.environment
        // 让子进程知道要跟着 App 一起退（父进程消失时自己退，见 poller._watch_parent）
        env["TP_EXIT_WITH_PARENT"] = "1"
        // 进程树是 App → uv → python，光靠 ppid 判断不到宿主死活，直接给 PID
        env["TP_HOST_PID"] = "\(ProcessInfo.processInfo.processIdentifier)"
        p.environment = env
        p.standardOutput = logHandle("taskpulse.poll.out")
        p.standardError = logHandle("taskpulse.poll.err")
        p.terminationHandler = { done in
            dbg("poller 退出 status=\(done.terminationStatus)")
        }
        do {
            try p.run()
            proc = p
            startedByUs = true
            dbg("poller 已启动 pid=\(p.processIdentifier)")
        } catch {
            dbg("poller 启动失败: \(error)")
        }
    }

    private func logHandle(_ name: String) -> FileHandle? {
        let dir = home + "/Library/Logs"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/" + name
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        let h = try? FileHandle(forWritingAtPath: path)
        h?.seekToEndOfFile()
        return h
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var panel: NSPanel!
    var view: PulseView!
    let poller = PollerRunner()
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
        // 从「下载」里双击运行：先把自己装到 ~/Applications，
        // 这样启动台和 Spotlight 才找得到，之后用户从那里打开。
        if installSelfIfNeeded() { return }
        // 退出按钮会摘掉 LaunchAgent，之后用户双击 App 是「手工启动」的。
        // 若再登录，launchd 也会拉起一个——两个面板叠一起。这里保证只有一个。
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.hyj.taskpulse")
        // 自检开关：两台实例同 bundle id 时，隔离测试会被这条挡掉
        let skipInstanceCheck = ProcessInfo.processInfo.environment["TP_SKIP_INSTANCE_CHECK"] == "1"
        if running.count > 1 && !skipInstanceCheck {
            // 同上：先把已有窗口叫到前面，避免看起来像闪退
            running.first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier })?
                .activate(options: [.activateAllWindows])
            dbg("已有实例在运行（running=\(running.count)），激活并退出")
            NSApp.terminate(nil)
            return
        }
        dbg("进入主流程 ready=\(Bootstrap.isReady())")
        buildPanel()
        applyLayout()
        refresh()
        // 首次打开：先把运行环境准备到用户目录（原来由 install.command 做），
        // 之后再起后台。已经初始化过的机器直接起，跳过一次额外检查。
        if Bootstrap.isReady() && Bootstrap.refreshPaths() {
            poller.startIfNeeded()
        } else {
            runBootstrap()
        }
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
        // 诊断入口：TP_TEST_EXPAND_ALL=1 启动后自动把所有分组展开一次，
        // 用来核对表头双击那种「全展开」后的排版（不需要注入鼠标）
        if ProcessInfo.processInfo.environment["TP_TEST_EXPAND_ALL"] == "1" {
            // 等扩展把标签组上报上来（最多 15 秒），否则展开的是空的「未分组」
            DispatchQueue.main.asyncAfter(deadline: .now() + 20.0) { [weak self] in
                self?.view.toggleAllGroups()
            }
        }

        // 诊断入口：TP_TEST_TOAST=1 启动时弹一条测试提示条，用来确认右上角
        // 那条「Agent 回话了」到底能不能显示（毛玻璃渲染在部分机器上会失效）
        if ProcessInfo.processInfo.environment["TP_TEST_TOAST"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                guard let self, let first = self.view.payload?.all.first else {
                    self?.showToast(TaskItem(id: 0, name: "测试提示条", group: nil, status: "attention",
                                             prev: nil, progress: 0, elapsed: 0, idle_minutes: 0,
                                             overdue: false, failed: nil, muted: nil, stale: nil,
                                             reply_version: nil, important: nil, has_tab: nil),
                                   title: "测试提示条", body: "如果你看到这条，说明提示条正常")
                    return
                }
                self.showToast(first, title: "测试提示条", body: "如果你看到这条，说明提示条正常")
            }
        }

        // 全新安装首次启动：先带一遍扩展安装引导
        if OnboardingController.shouldShow {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                OnboardingController.shared.show()
            }
        }
    }

    private var installedSelf = false

    /// 把当前这份 App 复制到 ~/Applications 并重启到那里。
    /// 返回 true 表示本次启动到此为止（调用方直接 return）。
    ///
    /// 不覆盖更新的副本：从下载目录又双击了旧 ZIP 时，直接启动已装好的那份，
    /// 避免把新版盖掉。版本号用 Info.plist 的 CFBundleVersion（构建日期）。
    private func installSelfIfNeeded() -> Bool {
        let selfPath = Bundle.main.bundlePath
        let target = Bootstrap.home + "/Applications/TaskPulse.app"
        if selfPath == target { return false }

        let fm = FileManager.default
        let mine = (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? ""
        let existing = (Bundle(path: target)?.infoDictionary?["CFBundleVersion"] as? String) ?? ""

        // 只有磁盘上那份「更新」才跳过；版本相同也覆盖，避免同一天多次构建
        // 时双击下载目录里的包却启动了旧副本
        if !existing.isEmpty && existing > mine {
            dbg("已安装 \(existing)（当前 \(mine)），直接启动它")
            launchLater(target)
            NSApp.terminate(nil)
            return true
        }

        dbg("自我安装：\(selfPath) -> \(target)（当前 \(mine)，已装 \(existing.isEmpty ? "无" : existing)）")
        OnboardingController.shared.showInstalling()
        DispatchQueue.global(qos: .userInitiated).async {
            // 升级时旧版本可能正在运行：先让它退出，否则新实例启动会被
            // 单实例检查（running.count > 1）直接挡回去，看起来像「没装上」
            Self.stopOtherInstances()
            do {
                if fm.fileExists(atPath: target) { try fm.removeItem(atPath: target) }
                try fm.createDirectory(atPath: (target as NSString).deletingLastPathComponent,
                                       withIntermediateDirectories: true)
                try fm.copyItem(atPath: selfPath, toPath: target)
                dbg("自我安装：复制完成，准备启动新位置")
                DispatchQueue.main.async {
                    self.launchLater(target)
                    NSApp.terminate(nil)
                }
            } catch {
                dbg("自我安装失败：\(error)")
                DispatchQueue.main.async {
                    // 装不过去也不耽误用：继续在当前路径跑
                    self.installedSelf = true
                    OnboardingController.shared.hidePanel()
                    if Bootstrap.isReady() {
                        self.poller.startIfNeeded()
                    } else {
                        self.runBootstrap()
                    }
                }
            }
        }
        return true
    }

    /// 结束同 bundle id 的其他实例（升级时旧版本还开着）
    private static func stopOtherInstances() {
        let me = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.hyj.taskpulse")
            .filter { $0.processIdentifier != me }
        for app in others { app.terminate() }
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            let alive = NSRunningApplication
                .runningApplications(withBundleIdentifier: "com.hyj.taskpulse")
                .filter { $0.processIdentifier != me && !$0.isTerminated }
            if alive.isEmpty { break }
            usleep(120_000)
        }
        dbg("自我安装：已结束 \(others.count) 个旧实例")
    }

    /// 延迟 1 秒再启动目标 App：本实例要先退出，否则目标的单实例检查会把它挡回去
    private func launchLater(_ target: String) {
        let env = ProcessInfo.processInfo.environment
        let cmd: String
        if let tpHome = env["TP_HOME"], !tpHome.isEmpty {
            // 自检：open 不传递环境变量，直接起二进制才能把隔离家目录带过去
            let bin = target + "/Contents/MacOS/TaskPulse"
            cmd = "nohup sh -c 'sleep 1; exec \"\(bin)\"' >/dev/null 2>&1 &"
        } else {
            // -n：强制新实例；open 失败（LaunchServices 还没登记这个新副本）时
            // 直接执行二进制兜底——否则用户看到的是「窗口一闪，什么都没起来」。
            let bin = target + "/Contents/MacOS/TaskPulse"
            cmd = "nohup sh -c \"sleep 1; open -n '\(target)' || exec '\(bin)'\" >/dev/null 2>&1 &"
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", cmd]
        try? p.run()
        p.waitUntilExit()
    }

    private var bootstrapRunning = false

    /// 首次启动的初始化：进度与失败都显示在那个引导面板里，失败可重试。
    func runBootstrap() {
        guard !bootstrapRunning else { return }
        bootstrapRunning = true
        OnboardingController.shared.showBootstrap { [weak self] plan in
            guard let self else { return }
            self.bootstrapRunning = false
            self.poller.start(with: plan)
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

        // 记住上次贴的是哪条边，重启后按同一条边对齐
        let side = d.string(forKey: "anchorSide") ?? "right"
        var left = saved?.x ?? (vf.maxX - w0 - 4)
        if saved == nil {
            // 首次启动：贴主屏那条边
            if side == "right" { left = vf.maxX - w0 } else if side == "left" { left = vf.minX }
        } else if side == "right" || side == "left" {
            // 有保存位置：在「它所在那块屏」上对齐同一条边。
            // 以前这里一律用主屏 vf，副屏上的位置每次重启都被拽回主屏。
            let probe = NSRect(x: left, y: top - h0, width: w0, height: h0)
            let screen = screenFor(probe)
            left = (side == "right") ? screen.maxX - w0 : screen.minX
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
        // 先套一层圆角容器：NSVisualEffectView 的背景模糊不吃自己的 masksToBounds，
        // 只给它设 cornerRadius 会在四角露出一圈没被裁掉的浅色（看起来就是"边角白色"）。
        let container = NSView(frame: NSRect(x: 0, y: 0, width: w0, height: h0))
        container.wantsLayer = true
        container.layer?.cornerRadius = glassRadius
        container.layer?.masksToBounds = true
        // 外框描边交给内容自己画（收起态是胶囊外壳、展开态是视图边缘），
        // 容器再加一圈 1pt 会在圆角处叠成一条白边
        panel.contentView = container

        let bg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: w0, height: h0))
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.appearance = NSAppearance(named: .darkAqua)
        bg.autoresizingMask = [.width, .height]
        container.addSubview(bg)

        let tint = NSView(frame: bg.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = panelTint.cgColor
        tint.autoresizingMask = [.width, .height]
        // 明暗扩散：左上提亮、右下压暗，一层斜向渐变贯到底；
        // 参考图里每块玻璃都是这个走向（亮部在左上，暗部沉到右下）。
        let diffusion = CAGradientLayer()
        diffusion.frame = tint.bounds
        diffusion.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        diffusion.startPoint = CGPoint(x: 0.08, y: 1.0)
        diffusion.endPoint = CGPoint(x: 0.92, y: 0.0)
        diffusion.colors = [rgb(0xCBE3F1, alpha: 0.14).cgColor,
                            rgb(0xCBE3F1, alpha: 0.02).cgColor,
                            rgb(0x061319, alpha: 0.22).cgColor]
        diffusion.locations = [0, 0.42, 1]
        tint.layer?.addSublayer(diffusion)

        // 顶部 1px 内高光，当作玻璃厚度
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
        view.onSetSource = { [weak self] mode in self?.setSource(mode) }
        view.onQuit = { [weak self] in self?.quitApp() }
        view.onReauthorize = { [weak self] in self?.reauthorize() }
        view.onOpen = { [weak self] item in self?.open(item) }
        view.onCheck = { [weak self] item, on in on ? self?.ack(item) : self?.unack(item) }
        view.onDeadline = { [weak self] item, m in self?.setDeadline(item, minutes: m) }
        view.onImportant = { [weak self] item, on in self?.setImportant(item, on) }
        view.onCloseTabs = { [weak self] mode in self?.closeTabs(mode) }
        view.onDragStart = { [weak self] in self?.dragBegan() }
        view.onDragEnd = { [weak self] in self?.endDrag("mouseUp") }
        view.onToggleGroup = { [weak self] _ in self?.applyLayout() }
        view.onFilterChange = { [weak self] _ in self?.applyLayout() }
        container.addSubview(view)
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
        let v = screenFor(f)
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

        // 细条一旦不在屏幕边上（拖到中间、换分辨率、被系统挪走），自动展开成小窗
        if view.compact, !view.pinned, !nearAnyEdge(panel.frame) {
            expanded = true
            view.compact = false
            dbg("auto expand (not on edge)")
            applyLayout()
            wasInside = inside
            return
        }

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
            // 只有贴着屏幕边才允许收起；悬在中间时保持展开（否则会和下面的自动展开互踢）
            if !view.pinned && expanded && now - lastNear > 0.15 && nearAnyEdge(panel.frame) {
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
    /// 所有屏幕的并集：窗口要被允许拖到笔记本上方的显示器里，
    /// 只按主屏裁会把「往上拖」直接夹回来。
    func desktopBounds() -> NSRect {
        let frames = NSScreen.screens.map { $0.visibleFrame }
        guard var union = frames.first else { return NSRect(x: 0, y: 0, width: 1440, height: 900) }
        for f in frames.dropFirst() { union = union.union(f) }
        return union
    }

    /// 窗口当前落在哪块屏幕上（按中心点判断），贴边吸附以它为准。
    func screenFor(_ f: NSRect) -> NSRect {
        let c = NSPoint(x: f.midX, y: f.midY)
        if let hit = NSScreen.screens.first(where: { $0.frame.contains(c) }) { return hit.visibleFrame }
        return desktopBounds()
    }

    func visibleFrame() -> NSRect {
        let main = NSScreen.screens.first { $0.frame.origin == .zero }
            ?? NSScreen.main ?? NSScreen.screens.first
        return main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    func applyLayout(force: Bool = false) {
        guard panel != nil, !dragging else { return }
        let w = view.contentWidth()
        let h = max(view.layoutHeight(), 56)
        let v = desktopBounds()
        let screen = screenFor(panel.frame)
        var f = panel.frame
        let touchRight = abs(f.maxX - screen.maxX) <= 8
        let touchLeft = abs(f.minX - screen.minX) <= 8

        var x: CGFloat
        if touchRight {
            x = screen.maxX - w
        } else if touchLeft {
            x = screen.minX
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
        // 圆角常驻；描边只在展开态由容器画（收起态那条是胶囊自己的外壳）
        if let bg = panel.contentView {
            bg.layer?.cornerRadius = glassRadius
            bg.layer?.borderWidth = view.compact ? 0 : 1
            bg.layer?.borderColor = glassBorder.cgColor
        }
        view.rebuild()
    }

    /// 窗口是否贴着任意一条屏幕边（贴边才允许保持细条形态）
    func nearAnyEdge(_ f: NSRect) -> Bool {
        let v = screenFor(f)
        return f.maxX >= v.maxX - EDGE_SNAP || f.minX <= v.minX + EDGE_SNAP
            || f.maxY >= v.maxY - EDGE_SNAP || f.minY <= v.minY + EDGE_SNAP
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
        let f = panel.frame
        // 必须在「窗口所在的那块屏」上判断贴边：副屏在主屏右侧时，
        // 窗口的 x 远大于主屏 maxX，用主屏判断会误判成「贴右边缘」，
        // 一松手就被吸回主屏。
        let v = screenFor(f)
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
            // 兜底：不许跑出当前这块屏
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
            // 细条只在贴边时有意义：松手后离开了边缘，就展开成小窗
            if !nearEdge {
                expanded = true
            } else {
                expanded = wasCompactAtDragStart ? false : f.contains(NSEvent.mouseLocation)
            }
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
        // 用户标了「完成后提醒我」的会话：弹窗用状态色标出来，且不自动消失
        let pinned = item.important == true
        tv.emphasize = pinned

        let np = ToastPanel(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        np.level = .statusBar
        np.isOpaque = false
        np.backgroundColor = .clear
        np.hasShadow = true
        np.hidesOnDeactivate = false
        np.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // 与主面板同一套毛玻璃：同样要套圆角容器，否则四角会露出一圈没裁掉的浅色
        let tcontainer = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        tcontainer.wantsLayer = true
        tcontainer.layer?.cornerRadius = glassRadius
        tcontainer.layer?.masksToBounds = true
        np.contentView = tcontainer

        let tbg = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        tbg.material = .hudWindow
        tbg.blendingMode = .behindWindow
        tbg.state = .active
        tbg.appearance = NSAppearance(named: .darkAqua)
        tbg.autoresizingMask = [.width, .height]
        tcontainer.addSubview(tbg)

        tv.frame = tbg.bounds
        tv.autoresizingMask = [.width, .height]
        tbg.addSubview(tv)

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
        // 常驻的（重要）保留，普通条先让位，避免重要提醒被挤掉
        while toasts.count > 3 {
            if let idx = toasts.lastIndex(where: { $0.timer != nil }) , idx > 0 {
                let old = toasts.remove(at: idx)
                old.timer?.invalidate()
                old.panel.orderOut(nil)
            } else {
                let old = toasts.removeLast()
                old.timer?.invalidate()
                old.panel.orderOut(nil)
            }
        }
        layoutToasts()

        np.alphaValue = 0
        np.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            np.animator().alphaValue = 1
        }

        // 重要会话不设自动关闭：必须由用户点一下才算看过
        if !pinned {
            handle.timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self, weak handle] _ in
                guard let self, let hd = handle else { return }
                self.dismissToast(hd)
            }
        }
    }

    /// 最新一条在最上面，越旧越往下，叠压 20pt
    func layoutToasts() {
        let w: CGFloat = 288, h: CGFloat = 64
        // 提示条跟随小窗所在的屏幕：小窗在副屏时，提示条也该出现在副屏
        let v = screenFor(panel?.frame ?? NSRect(x: 0, y: 0, width: 1, height: 1))
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
        withToken(&req)
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
                let prevSource = self.view.payload?.source
                let items = self.view.compact ? [] : self.view.visibleItems()
                self.view.connectionLost = payload == nil
                if let payload {
                    self.view.payload = payload
                    // 后端确认切换到位后，清掉点击时的乐观标记
                    if self.view.pendingSource == payload.source { self.view.pendingSource = nil }
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
                    || prevSource != self.view.payload?.source
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
        withToken(&req)
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

    func applicationWillTerminate(_ notification: Notification) {
        poller.stop()
    }

    /// 退出：整个 App 结束，取数子进程在 applicationWillTerminate 里一起停。
    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    /// 凭据失效时点「扫码重新授权」：在终端里跑授权脚本，二维码会同时出现在
    /// 独立浏览器窗口里，扫完脚本会自己验证取数。
    func reauthorize() {
        let script = NSHomeDirectory() + "/Applications/TaskPulse/api_login.command"
        guard FileManager.default.fileExists(atPath: script) else {
            // 脚本被删了：至少把安装目录打开，用户能看见缺什么
            dbg("reauthorize: 缺少 \(script)")
            NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Applications/TaskPulse"))
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", "Terminal", script]
        do {
            try p.run()
            dbg("reauthorize: 已打开终端运行 api_login.command")
        } catch {
            dbg("reauthorize 失败: \(error)")
        }
    }

    /// 切换取数来源：api = 本机 token，web = 浏览器里用 cookie 取数
    func setSource(_ mode: String) {
        view.pendingSource = mode
        applyLayout()
        post("/mode?value=\(mode)")
    }

    func post(_ path: String) {
        guard let url = URL(string: endpoint + path) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        withToken(&req)
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

    /// 批量关掉没在用的会话标签；服务端按同一套规则再筛一次。
    /// 单独实现而不用 post()：要把实际关掉的条数回显出来，用户才知道生效了。
    func closeTabs(_ mode: String) {
        guard let url = URL(string: endpoint + "/tabs/close?mode=\(mode)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 12
        withToken(&req)
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            let result = data.flatMap { try? JSONDecoder().decode(CloseResult.self, from: $0) }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            DispatchQueue.main.async {
                guard let self else { return }
                if code == 200, let n = result?.closed {
                    self.view.actionMessage = n > 0 ? "已关闭 \(n) 个标签页" : "没有可关闭的标签页"
                } else {
                    self.view.actionMessage = "清理未完成，请重试"
                }
                self.applyLayout()
                // 提示只是回执，别一直挂在标题栏
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    self?.view.actionMessage = nil
                    self?.applyLayout()
                }
                self.nextReadAt = 0
                self.refresh()
            }
        }.resume()
    }

    /// 「完成后提醒我」：只影响展示与弹窗，不改状态判定
    func setImportant(_ item: TaskItem, _ on: Bool) {
        post("/important?id=\(item.id)&value=\(on ? 1 : 0)")
    }

    func setDeadline(_ item: TaskItem, minutes: Int?) {
        let duration = minutes.map { "&minutes=\($0)" } ?? ""
        post("/deadline?id=\(item.id)" + duration)
    }
}

private struct ActionResult: Decodable {
    let ok: Bool
}

private struct CloseResult: Decodable {
    let ok: Bool
    let closed: Int?
}

// 自检入口：在终端里跑一遍初始化，打印每一步结果（不需要图形界面）
if CommandLine.arguments.contains("--bootstrap-check") {
    do {
        let plan = try Bootstrap.runSync()
        print("OK uv=\(plan.uv)")
        print("   poller=\(plan.poller)")
        print("   port=\(plan.port)  args=\(plan.args.count) 个")
        exit(0)
    } catch {
        print("FAIL \(error)")
        exit(1)
    }
}

// 启动埋点：闪退时这行是唯一线索，所以放在最前面
dbg("启动 pid=\(getpid()) path=\(Bundle.main.bundlePath)")

// 单实例：两把锁分开。
//   - 已安装的那份（~/Applications）用 ui.lock，保证「只开一个窗口」
//   - 从下载目录双击的那份用 installer.lock，它的职责是装/升级
// 如果共用一把锁，升级时安装器会被正在运行的旧版本直接挡在 main 里，
// 表现为「双击新包没反应」。
try? FileManager.default.createDirectory(atPath: Bootstrap.stateDir,
                                         withIntermediateDirectories: true)
let isInstalledCopy = Bundle.main.bundlePath == Bootstrap.home + "/Applications/TaskPulse.app"
let lockPath = Bootstrap.stateDir + (isInstalledCopy ? "/ui.lock" : "/installer.lock")
if !FileManager.default.fileExists(atPath: lockPath) {
    FileManager.default.createFile(atPath: lockPath, contents: nil)
}
let appLock = try? FileHandle(forWritingTo: URL(fileURLWithPath: lockPath))
if let appLock, flock(appLock.fileDescriptor, LOCK_EX | LOCK_NB) != 0 {
    // 已经有一个在跑：把它叫到前面来再退出。
    // 以前这里是静默 exit(0)，用户双击第二次时看到的就是「闪退」。
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.hyj.taskpulse")
        .first?.activate(options: [.activateAllWindows])
    dbg("已有实例在运行（\(isInstalledCopy ? "ui" : "installer")），激活它并退出")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
withExtendedLifetime(appLock) { app.run() }

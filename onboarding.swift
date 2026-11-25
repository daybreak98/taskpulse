// 首次安装引导：让用户选 Edge 或 Chrome，装一次浏览器桥接扩展。
// 扩展只读「标签标题 + 标签组名」，数据只发 127.0.0.1，不读页面内容、不联网外传。
//
// 触发条件：UserDefaults 里没有 onboarded 键（全新安装首次启动），
// 或环境变量 TP_ONBOARDING=1（重放引导，便于排查）。

import AppKit
import Foundation

/// 引导窗口要能拿到键盘焦点（输入框/按钮/回车），无边框面板默认不行。
final class OnboardingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        OnboardingController.shared.dismissNow()
    }
}

final class OnboardingController {
    static let shared = OnboardingController()

    private var panel: NSPanel?
    private var body: NSStackView?
    private var pollTimer: Timer?
    private var browser: String?

    /// 扩展目录：安装脚本放在 ~/Applications/TaskPulse/edge-ext；
    /// 直接跑源码调试时，用 App 包同级的 TaskPulse/edge-ext 或当前目录的 edge-ext。
    private var extDir: String {
        let fm = FileManager.default
        var candidates: [URL] = [
            fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/TaskPulse/edge-ext"),
            Bundle.main.bundleURL.deletingLastPathComponent()
                .appendingPathComponent("TaskPulse/edge-ext"),
            URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("edge-ext"),
        ]
        if let res = Bundle.main.resourceURL { candidates.append(res.appendingPathComponent("edge-ext")) }
        for url in candidates where fm.fileExists(atPath: url.path) { return url.path }
        return candidates[0].path
    }

    private var extDirExists: Bool {
        FileManager.default.fileExists(atPath: extDir)
    }

    private func appURL(_ app: String) -> URL {
        let fm = FileManager.default
        let roots = fm.urls(for: .applicationDirectory, in: .localDomainMask)
            + fm.urls(for: .applicationDirectory, in: .userDomainMask)
        for root in roots {
            let url = root.appendingPathComponent("\(app).app")
            if fm.fileExists(atPath: url.path) { return url }
        }
        return roots[0].appendingPathComponent("\(app).app")
    }

    private func installed(_ app: String) -> Bool {
        FileManager.default.fileExists(atPath: appURL(app).path)
    }

    static var shouldShow: Bool {
        if ProcessInfo.processInfo.environment["TP_ONBOARDING"] == "1" { return true }
        return !UserDefaults.standard.bool(forKey: "onboarded")
    }

    func show() {
        dbg("onboarding show, existing=\(panel != nil)")
        if let p = panel {
            p.makeKeyAndOrderFront(nil)
            return
        }
        let w: CGFloat = 430, h: CGFloat = 320
        let screen = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let rect = NSRect(x: screen.midX - w / 2, y: screen.midY - h / 2, width: w, height: h)

        let p = OnboardingPanel(contentRect: rect,
                                styleMask: [.borderless],
                                backing: .buffered, defer: false)
        // 后台常驻 App 的引导窗口必须是「别人都盖不住」的一层：
        // .floating 会被前台普通窗口压住，用户就完全看不到引导
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        // 从胶囊右键重放引导时前台是别的 App，面板默认会「失活即隐藏」→ 显式关掉
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let container = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        // 按钮是 container 的直接子视图，不在背景层之下。外观必须在 container 上
        // 设，否则浅色模式下 .rounded 按钮画白底、而我们用浅色字，整块糊白。
        container.appearance = NSAppearance(named: .darkAqua)
        container.wantsLayer = true
        container.layer?.cornerRadius = glassRadius
        container.layer?.masksToBounds = true
        p.contentView = container

        let bg = NSVisualEffectView(frame: container.bounds)
        // 面板本身是深色玻璃；不锁深色外观时，系统浅色模式下 .rounded 按钮
        // 会画成白底，而我们给标题用的是浅色，整块按钮就糊成一片白
        bg.appearance = NSAppearance(named: .darkAqua)
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.autoresizingMask = [.width, .height]
        container.addSubview(bg)

        let tint = NSView(frame: container.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = rgb(0x1D2C35, alpha: 0.92).cgColor
        tint.autoresizingMask = [.width, .height]
        container.addSubview(tint)

        let border = NSView(frame: container.bounds)
        border.wantsLayer = true
        border.layer?.borderWidth = 1
        border.layer?.borderColor = glassBorder.cgColor
        border.layer?.cornerRadius = glassRadius
        border.layer?.backgroundColor = NSColor.clear.cgColor
        border.autoresizingMask = [.width, .height]
        container.addSubview(border)

        self.panel = p
        // 常驻 App 是 accessory（无 Dock 图标），弹窗要临时变成普通 App 才拿得到焦点，
        // 否则第一次点击会被系统当成「激活点击」吞掉
        NSApp.setActivationPolicy(.regular)
        // 自检入口：TP_TEST_STEPS=Edge / Chrome 直接进「装扩展」那一页，
        // 不需要注入鼠标就能核对路径是否完整可见
        if let forced = ProcessInfo.processInfo.environment["TP_TEST_STEPS"], !forced.isEmpty {
            browser = forced.contains("Edge") ? "Microsoft Edge" : "Google Chrome"
            renderSteps(browser ?? "Microsoft Edge")
        } else {
            renderChoice()
        }
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        // 后台常驻 App 的激活随时会被抢走；面板一旦失活就会掉到别的窗口后面，
        // 所以再无条件抬一次层级，保证看得见
        p.orderFrontRegardless()
        // 无边框面板要等一轮 runloop 才真正拿到键盘焦点
        DispatchQueue.main.async { [weak self] in
            guard let p = self?.panel else { return }
            NSApp.activate(ignoringOtherApps: true)
            p.makeKeyAndOrderFront(nil)
            p.orderFrontRegardless()
            dbg("onboarding shown key=\(p.isKeyWindow) visible=\(p.isVisible) f=\(p.frame)")
            // 排查用：TP_ONBOARDING_PICK=edge|chrome 直接进步骤页
            // （本机没有辅助功能权限，没法合成点击）
            if let pick = ProcessInfo.processInfo.environment["TP_ONBOARDING_PICK"] {
                let name = pick.lowercased() == "chrome" ? "Google Chrome" : "Microsoft Edge"
                let fake = NSButton()
                fake.tag = name.contains("Edge") ? 1 : 2
                self?.pickBrowser(fake)
            }
        }
    }

    // MARK: - 页面

    private func resetBody() {
        body?.removeFromSuperview()
        body = nil
    }

    private func newBody() -> NSStackView {
        resetBody()
        let s = NSStackView()
        s.orientation = .vertical
        s.alignment = .leading
        s.spacing = 10
        s.translatesAutoresizingMaskIntoConstraints = false
        panel?.contentView?.addSubview(s)
        if let cv = panel?.contentView {
            NSLayoutConstraint.activate([
                s.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: 22),
                s.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -22),
                s.topAnchor.constraint(equalTo: cv.topAnchor, constant: 22),
            ])
        }
        body = s
        return s
    }

    /// 窗口高度跟着内容走：否则内容少的页面下方会留一大块空底
    private func fitHeight() {
        resizeToFit()
        // 换行标签的高度要等一轮布局才准，补算一次
        DispatchQueue.main.async { [weak self] in self?.resizeToFit() }
    }

    private func resizeToFit() {
        guard let p = panel, let s = body, let cv = p.contentView else { return }
        cv.layoutSubtreeIfNeeded()
        s.layoutSubtreeIfNeeded()
        let wanted = max(180, ceil(s.fittingSize.height) + 60)
        var f = p.frame
        guard abs(f.height - wanted) > 0.5 else { return }
        f.origin.y = f.maxY - wanted
        f.size.height = wanted
        p.setFrame(f, display: true)
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                       color: NSColor = mainText, wrap: Bool = true) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: text)
        f.font = NSFont.systemFont(ofSize: size, weight: weight)
        f.textColor = color
        f.isEditable = false
        f.isBezeled = false
        f.drawsBackground = false
        f.maximumNumberOfLines = wrap ? 0 : 1
        return f
    }

    private func closeButton() -> NSButton {
        let b = NSButton(title: "关闭", target: self, action: #selector(dismiss))
        b.bezelStyle = .inline
        b.isBordered = false
        b.contentTintColor = secondaryText
        b.font = NSFont.systemFont(ofSize: 11)
        return b
    }

    /// 深色底上的主按钮：系统默认按钮文字是黑的，这里统一成浅色
    private func actionButton(_ title: String, _ sel: Selector, key: String = "") -> NSButton {
        let b = NSButton(title: title, target: self, action: sel)
        b.bezelStyle = .rounded
        b.attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: mainText,
            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
        ])
        if !key.isEmpty { b.keyEquivalent = key }
        return b
    }

    private func linkButton(_ title: String, _ sel: Selector) -> NSButton {
        let b = NSButton(title: title, target: self, action: sel)
        b.bezelStyle = .inline
        b.isBordered = false
        b.attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: secondaryText,
            .font: NSFont.systemFont(ofSize: 11),
        ])
        return b
    }

    /// 已经在往本机上报的浏览器，按钮上直接标「已连接」：
    /// 否则用户会对着 Edge 装好的结果去 Chrome 里再装一遍。
    private func markConnected(_ pick: NSStackView) {
        guard let url = URL(string: endpoint + "/state") else { return }
        var req = URLRequest(url: url)
        withToken(&req)          // 本机服务要鉴权，不带票会被 401 当成「后台没起来」
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let d = data,
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let ext = obj["extension"] as? [String: Any] else { return }
            let live = (ext["browsers"] as? [String]) ?? []
            guard !live.isEmpty else { return }
            DispatchQueue.main.async {
                for case let b as NSButton in pick.arrangedSubviews {
                    let key = b.tag == 1 ? "edge" : "chrome"
                    guard b.isEnabled, live.contains(key) else { continue }
                    let app = b.tag == 1 ? "Edge" : "Chrome"
                    b.attributedTitle = NSAttributedString(string: "\(app) 已连接", attributes: [
                        .foregroundColor: palette["done"] ?? mainText,
                        .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
                    ])
                }
                self?.resizeToFit()
            }
        }.resume()
    }

    // MARK: - 首次初始化

    private var bootstrapReady: ((Bootstrap.Plan) -> Void)?
    private var bootstrapRetry: (() -> Void)?

    /// 首次打开 App 时走这里：把 uv / Python / 配置 / 扩展准备到用户目录。
    func showBootstrap(onReady: @escaping (Bootstrap.Plan) -> Void) {
        bootstrapReady = onReady
        show()
        beginBootstrap()
    }

    private func beginBootstrap() {
        renderBootstrapping("检查目录")
        Bootstrap.run(progress: { [weak self] step in
            self?.renderBootstrapping(step)
        }, completion: { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(plan):
                self.bootstrapReady?(plan)
                self.renderChoice()
            case let .failure(err):
                self.renderBootstrapFailed("\(err)")
            }
        })
    }

    private func renderBootstrapping(_ step: String) {
        let s = newBody()
        s.addArrangedSubview(label("正在准备运行环境", size: 16, weight: .semibold))
        s.addArrangedSubview(label(
            "第一次打开要把运行环境放到你的用户目录，通常十几秒（首次连内网装依赖会久一点）。"
            + "不需要终端，也不需要预装 Python。",
            size: 11.5, color: secondaryText))
        let line = label("…  " + step, size: 12.5, color: mainText)
        line.identifier = NSUserInterfaceItemIdentifier("bootstep")
        s.addArrangedSubview(line)
        fitHeight()
    }

    private func renderBootstrapFailed(_ message: String) {
        bootstrapRetry = { [weak self] in self?.beginBootstrap() }
        let s = newBody()
        s.addArrangedSubview(label("初始化没完成", size: 16, weight: .semibold,
                                   color: palette["attention"] ?? mainText))
        s.addArrangedSubview(label(message, size: 11.5, color: mainText))
        s.addArrangedSubview(label(
            "常见原因：没连公司网络（装依赖要走内网源），或者系统拦下了 App 里的运行文件。"
            + "处理好之后点「重试」，已经完成的部分不会重来。",
            size: 10.5, color: secondaryText))
        s.addArrangedSubview(actionButton("重试", #selector(retryBootstrap), key: "\r"))
        s.addArrangedSubview(linkButton("打开日志目录", #selector(revealLogs)))
        fitHeight()
    }

    @objc private func retryBootstrap() {
        bootstrapRetry?()
    }

    @objc private func revealLogs() {
        NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs"))
    }

    private func renderChoice() {
        let s = newBody()
        s.addArrangedSubview(label("TaskPulse 已装好", size: 16, weight: .semibold))
        s.addArrangedSubview(label(
            "再装一次浏览器扩展，它只把标签页标题和标签组名读给本机小窗，"
            + "用来把会话归到你的标签组、并知道你正在看哪一个。"
            + "不读页面内容，也不发到任何服务器。",
            size: 11.5, color: secondaryText))
        s.setCustomSpacing(16, after: s.arrangedSubviews.last!)

        let browsers = [("Microsoft Edge", "Edge"), ("Google Chrome", "Chrome")]
        let available = browsers.filter { installed($0.0) }
        let pick = NSStackView()
        pick.orientation = .horizontal
        pick.spacing = 10
        for (name, app) in browsers {
            let ok = installed(name)
            let btn = actionButton(ok ? "用 \(app)" : "\(app) 未安装",
                                   #selector(pickBrowser(_:)))
            btn.tag = (name == "Microsoft Edge") ? 1 : 2
            btn.isEnabled = ok
            pick.addArrangedSubview(btn)
        }
        s.addArrangedSubview(pick)
        markConnected(pick)

        if available.isEmpty {
            // 一个都没有：直接给下载入口，别让人卡在「未安装」上
            s.addArrangedSubview(label(
                "这台机器上没找到 Edge 或 Chrome。随便装一个再回来，扩展只支持 Chromium 内核的浏览器。",
                size: 11.5, color: palette["attention"] ?? secondaryText))
            let dl = NSStackView()
            dl.orientation = .horizontal
            dl.spacing = 10
            dl.addArrangedSubview(linkButton("下载 Edge", #selector(downloadEdge)))
            dl.addArrangedSubview(linkButton("下载 Chrome", #selector(downloadChrome)))
            s.addArrangedSubview(dl)
        }

        s.addArrangedSubview(linkButton("以后再说", #selector(dismissForever)))
        fitHeight()
    }

    /// 用户只做两件事：开「开发人员模式」、把扩展目录拖进去（或选目录）。
    /// 打开扩展页、选中目录、复制路径、检测上报都由这里自动完成。
    private func renderSteps(_ browserName: String) {
        let s = newBody()
        s.addArrangedSubview(label("在 \(browserName) 里装扩展", size: 16, weight: .semibold))
        let dir = extDir

        if !extDirExists {
            s.addArrangedSubview(label(
                "没找到扩展目录（\(dir)）。安装包可能不完整，重新跑一次安装脚本即可。",
                size: 11.5, color: palette["attention"] ?? secondaryText))
        } else {
            s.addArrangedSubview(label(
                "扩展页已经打开，扩展目录也已经在 Finder 里选中。只剩两步：",
                size: 11.5, color: secondaryText))
        }

        s.addArrangedSubview(label(
            "1. 在 \(browserName) 扩展页右上角打开「开发人员模式」。",
            size: 11.5, color: secondaryText))
        s.addArrangedSubview(label(
            "2. 把 Finder 里选中的 edge-ext 文件夹，直接拖到扩展页中间的空区域。",
            size: 11.5, color: secondaryText))
        s.addArrangedSubview(label(
            "拖不了就点「加载解压缩的扩展」→ 按 ⌘⇧G 粘贴路径（已复制）→ 回车。",
            size: 10.5, color: secondaryText))

        // 路径要完整可见：用户得照着它在文件选择框里逐级找目录，
        // 单行截断（byTruncatingMiddle）看不出全貌，等于没给
        let path = label(dir, size: 11, color: mainText, wrap: true)
        path.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        path.lineBreakMode = .byCharWrapping
        path.isSelectable = true
        // 换行要按面板实际内容宽度算，否则 wrappingLabel 会按固有宽度摊成一行跑出面板
        path.preferredMaxLayoutWidth = (panel?.contentView?.bounds.width ?? 430) - 44
        s.addArrangedSubview(path)

        let pathRow = NSStackView()
        pathRow.orientation = .horizontal
        pathRow.spacing = 8
        pathRow.addArrangedSubview(linkButton("再复制一次", #selector(copyPath)))
        pathRow.addArrangedSubview(linkButton("在 Finder 里选中", #selector(revealDir)))
        pathRow.addArrangedSubview(linkButton("重新打开扩展页", #selector(reopenExtensions)))
        s.addArrangedSubview(pathRow)

        // 用户最常踩的坑：跑去 Kim/下载目录里那份 edge-ext 上加载。
        // 那份只有模板，没有 manifest.json，Chrome 会报「清单文件缺失」。
        s.addArrangedSubview(label(
            "加载时选的就是上面这个目录。解压包或 Kim / 下载目录里的 edge-ext 只有模板，"
            + "没有 manifest.json，会报「清单文件缺失或不可读取」。",
            size: 10.5, color: palette["attention"] ?? secondaryText))

        // 引导一次只带一个浏览器：两个都用的用户需要知道另一边上同一套动作
        let other = browserName.contains("Edge") ? "Chrome" : "Edge"
        s.addArrangedSubview(label(
            "两个浏览器都用？在 \(other) 的扩展页里重复这两步就行，选的是同一个 edge-ext 目录。",
            size: 10.5, color: secondaryText))

        let hint = label("正在检测扩展上报…装好后这里会自动跳到「已连接」。",
                         size: 10.5, color: secondaryText)
        hint.identifier = NSUserInterfaceItemIdentifier("hint")
        s.addArrangedSubview(hint)

        s.addArrangedSubview(linkButton("以后再说", #selector(dismissForever)))
        fitHeight()
    }

    private func renderDone() {
        let s = newBody()
        s.addArrangedSubview(label("已连接", size: 16, weight: .semibold, color: palette["done"] ?? mainText))
        s.addArrangedSubview(label(
            "扩展已经在往本机上报了。以后打开会话标签，小窗会自动同步分组和已读状态。",
            size: 11.5, color: secondaryText))
        s.setCustomSpacing(16, after: s.arrangedSubviews.last!)
        s.addArrangedSubview(actionButton("开始使用", #selector(finish), key: "\r"))
        fitHeight()
    }

    private func renderFailed(_ msg: String) {
        guard let s = body else { return }
        if let hint = s.arrangedSubviews.first(where: {
            $0.identifier?.rawValue == "hint"
        }) as? NSTextField {
            hint.textColor = palette["attention"]
            hint.stringValue = msg
        }
    }

    // MARK: - 动作

    /// 进入步骤页后挪到右下角：扩展页中间那块是「拖进来装」的落点，
    /// 面板一直占着正中间会挡住它。
    private func moveToCorner() {
        guard let p = panel else { return }
        let screen = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var f = p.frame
        f.origin = NSPoint(x: screen.maxX - f.width - 24, y: screen.minY + 24)
        p.setFrame(f, display: true)
    }

    @objc private func pickBrowser(_ sender: NSButton) {
        let name = sender.tag == 1 ? "Microsoft Edge" : "Google Chrome"
        browser = name
        open(extensionsURL: name)
        renderSteps(name)
        moveToCorner()
        // 文案说「已经准备好」，就别让用户再手动复制/找目录：这里真的做掉。
        // 目录在 Finder 里「选中」而不是只打开，这样可以直接把它拖进扩展页。
        if extDirExists {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(extDir, forType: .string)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: self.extDir)])
            }
        }
        startWatching()
    }

    /// 必须指定 App 打开：edge:// / chrome:// 不是系统级 scheme，
    /// 直接 NSWorkspace.open(url) 会静默失败，用户就卡在「什么都没打开」。
    private func open(extensionsURL app: String) {
        let scheme = app.contains("Edge") ? "edge" : "chrome"
        guard let url = URL(string: "\(scheme)://extensions") else { return }
        let target = appURL(app)
        guard FileManager.default.fileExists(atPath: target.path) else {
            NSWorkspace.shared.open(url)
            return
        }
        NSWorkspace.shared.open([url], withApplicationAt: target,
                                configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func downloadEdge() {
        if let url = URL(string: "https://www.microsoft.com/edge") { NSWorkspace.shared.open(url) }
    }

    @objc private func downloadChrome() {
        if let url = URL(string: "https://www.google.com/chrome") { NSWorkspace.shared.open(url) }
    }

    @objc private func reopenExtensions() {
        guard let b = browser else { return }
        open(extensionsURL: b)
    }

    @objc private func copyPath() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(extDir, forType: .string)
        renderFailed("路径已复制，粘贴到「选择扩展目录」窗口即可。")
    }

    @objc private func revealDir() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: extDir)])
    }

    /// 进入步骤页后自动轮询：连上就跳「已连接」，不用用户再点按钮。
    /// 判定必须按「用户刚选的那个浏览器」来做：Edge 装了不代表 Chrome 装了。
    private func startWatching() {
        pollTimer?.invalidate()
        var left = 180
        let want = browserKey(browser)
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
            guard let self else { t.invalidate(); return }
            left -= 2
            self.probe(for: want) { result in
                switch result {
                case .ok:
                    t.invalidate()
                    self.pollTimer = nil
                    self.renderDone()
                case .noBackend:
                    if left <= 0 {
                        t.invalidate()
                        self.pollTimer = nil
                        self.renderFailed("本机取数服务没起来（端口 \(taskPulsePort())）。在「活动监视器」里结束 TaskPulse 后重新打开 App 即可。")
                    }
                case .noExtension:
                    if left <= 0 {
                        t.invalidate()
                        self.pollTimer = nil
                        self.renderFailed("本机服务正常，但还没收到 \(self.browser ?? "浏览器") 的扩展上报。确认扩展在这个浏览器里已「启用」，并在这个浏览器里开着一个会话标签。")
                    } else {
                        self.renderFailed("服务正常，等待 \(self.browser ?? "浏览器") 的扩展上报…（还剩 \(left) 秒）")
                    }
                }
            }
        }
    }

    private enum Probe { case ok, noExtension, noBackend }

    /// "Microsoft Edge" -> "edge"，与扩展上报里的 browser 字段对齐
    private func browserKey(_ name: String?) -> String {
        guard let n = name else { return "" }
        return n.contains("Edge") ? "edge" : "chrome"
    }

    /// want 为空时退回旧的全局判断
    private func probe(for want: String = "", _ done: @escaping (Probe) -> Void) {
        guard let url = URL(string: endpoint + "/state") else { return done(.noBackend) }
        var req = URLRequest(url: url)
        withToken(&req)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var result = Probe.noBackend
            if let d = data,
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let ext = obj["extension"] as? [String: Any] {
                let live = ext["ok"] as? Bool ?? false
                let browsers = (ext["browsers"] as? [String]) ?? []
                if want.isEmpty || browsers.isEmpty {
                    // 老版本 poller 没有 browsers 字段，只能沿用全局判断
                    result = live ? .ok : .noExtension
                } else {
                    result = browsers.contains(want) ? .ok : .noExtension
                }
            }
            DispatchQueue.main.async { done(result) }
        }.resume()
    }

    @objc private func finish() {
        UserDefaults.standard.set(true, forKey: "onboarded")
        dismiss()
    }

    @objc private func dismissForever() {
        UserDefaults.standard.set(true, forKey: "onboarded")
        dismiss()
    }

    @objc private func dismiss() {
        pollTimer?.invalidate()
        pollTimer = nil
        panel?.orderOut(nil)
        panel = nil
        body = nil
        browser = nil
        // 回到后台常驻形态，别在 Dock 里留个图标
        NSApp.setActivationPolicy(.accessory)
    }

    /// Esc / 面板关闭走这里：不写 onboarded，下次启动还会提示
    func dismissNow() {
        dismiss()
    }
}

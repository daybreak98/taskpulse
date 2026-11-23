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
    private var checking = false

    /// 扩展目录：安装脚本会放到 ~/Applications/TaskPulse/edge-ext
    private var extDir: String {
        let app = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications/TaskPulse/edge-ext")
        if FileManager.default.fileExists(atPath: app.path) { return app.path }
        // 直接跑源码调试时退回仓库里的目录
        return FileManager.default.currentDirectoryPath + "/edge-ext"
    }

    private func installed(_ app: String) -> Bool {
        let p = "/Applications/\(app).app"
        return FileManager.default.fileExists(atPath: p)
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
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let container = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        container.wantsLayer = true
        container.layer?.cornerRadius = glassRadius
        container.layer?.masksToBounds = true
        p.contentView = container

        let bg = NSVisualEffectView(frame: container.bounds)
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.autoresizingMask = [.width, .height]
        container.addSubview(bg)

        let tint = NSView(frame: container.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = rgb(glassRGB, alpha: 0.72).cgColor
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
        renderChoice()
        dbg("onboarding panel frame=\(p.frame) visible=\(p.isVisible)")
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        dbg("onboarding shown key=\(p.isKeyWindow) visible=\(p.isVisible)")
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

    private func renderChoice() {
        let s = newBody()
        s.addArrangedSubview(label("TaskPulse 已装好", size: 16, weight: .semibold))
        s.addArrangedSubview(label(
            "再装一次浏览器扩展，它只把标签页标题和标签组名读给本机小窗，"
            + "用来把会话归到你的标签组、并知道你正在看哪一个。"
            + "不读页面内容，也不发到任何服务器。",
            size: 11.5, color: secondaryText))
        s.setCustomSpacing(16, after: s.arrangedSubviews.last!)

        let pick = NSStackView()
        pick.orientation = .horizontal
        pick.spacing = 10
        for (name, app) in [("Microsoft Edge", "Edge"), ("Google Chrome", "Chrome")] {
            let ok = installed(name)
            let btn = NSButton(title: ok ? "用 \(app)" : "\(app) 未安装",
                               target: self, action: #selector(pickBrowser(_:)))
            btn.bezelStyle = .rounded
            btn.tag = (name == "Microsoft Edge") ? 1 : 2
            btn.isEnabled = ok
            pick.addArrangedSubview(btn)
        }
        s.addArrangedSubview(pick)

        let skip = NSButton(title: "以后再说", target: self, action: #selector(dismissForever))
        skip.bezelStyle = .inline
        skip.isBordered = false
        skip.contentTintColor = secondaryText
        skip.font = NSFont.systemFont(ofSize: 11)
        s.addArrangedSubview(skip)
    }

    private func renderSteps(_ browserName: String) {
        let s = newBody()
        s.addArrangedSubview(label("在 \(browserName) 里装扩展", size: 16, weight: .semibold))
        let dir = extDir

        s.addArrangedSubview(label(
            "1. 已经在 \(browserName) 打开了扩展页：右上角打开「开发人员模式」。",
            size: 11.5, color: secondaryText))
        s.addArrangedSubview(label(
            "2. 点「加载解压缩的扩展」，选下面这个目录：",
            size: 11.5, color: secondaryText))

        let pathRow = NSStackView()
        pathRow.orientation = .horizontal
        pathRow.spacing = 8
        let path = label(dir, size: 11, color: mainText, wrap: false)
        path.lineBreakMode = .byTruncatingMiddle
        pathRow.addArrangedSubview(path)
        let copy = NSButton(title: "复制路径", target: self, action: #selector(copyPath))
        copy.bezelStyle = .inline
        copy.font = NSFont.systemFont(ofSize: 11)
        pathRow.addArrangedSubview(copy)
        let reveal = NSButton(title: "打开目录", target: self, action: #selector(revealDir))
        reveal.bezelStyle = .inline
        reveal.font = NSFont.systemFont(ofSize: 11)
        pathRow.addArrangedSubview(reveal)
        s.addArrangedSubview(pathRow)

        s.addArrangedSubview(label("3. 回到这里点「检查一下」。",
                                   size: 11.5, color: secondaryText))

        s.setCustomSpacing(18, after: s.arrangedSubviews.last!)
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 10
        let check = NSButton(title: "检查一下", target: self, action: #selector(check))
        check.bezelStyle = .rounded
        check.keyEquivalent = "\r"
        row.addArrangedSubview(check)
        let retry = NSButton(title: "重新打开扩展页", target: self, action: #selector(reopenExtensions))
        retry.bezelStyle = .inline
        retry.font = NSFont.systemFont(ofSize: 11)
        row.addArrangedSubview(retry)
        s.addArrangedSubview(row)

        let hint = label("装好扩展后，这个小窗会自动消失。", size: 10.5, color: secondaryText)
        hint.identifier = NSUserInterfaceItemIdentifier("hint")
        s.addArrangedSubview(hint)

        let skip = NSButton(title: "以后再说", target: self, action: #selector(dismissForever))
        skip.bezelStyle = .inline
        skip.isBordered = false
        skip.contentTintColor = secondaryText
        skip.font = NSFont.systemFont(ofSize: 11)
        s.addArrangedSubview(skip)
    }

    private func renderDone() {
        let s = newBody()
        s.addArrangedSubview(label("已连接", size: 16, weight: .semibold, color: palette["done"] ?? mainText))
        s.addArrangedSubview(label(
            "扩展已经在往本机上报了。以后打开会话标签，小窗会自动同步分组和已读状态。",
            size: 11.5, color: secondaryText))
        s.setCustomSpacing(16, after: s.arrangedSubviews.last!)
        let ok = NSButton(title: "开始使用", target: self, action: #selector(finish))
        ok.bezelStyle = .rounded
        ok.keyEquivalent = "\r"
        s.addArrangedSubview(ok)
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

    @objc private func pickBrowser(_ sender: NSButton) {
        let name = sender.tag == 1 ? "Microsoft Edge" : "Google Chrome"
        browser = name
        open(extensionsURL: name)
        renderSteps(name)
        let dir = extDir
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            NSWorkspace.shared.open(URL(fileURLWithPath: dir))
        }
    }

    private func open(extensionsURL app: String) {
        let scheme = app.contains("Edge") ? "edge" : "chrome"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", app, "\(scheme)://extensions"]
        try? p.run()
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
        NSWorkspace.shared.open(URL(fileURLWithPath: extDir))
    }

    @objc private func check() {
        guard !checking else { return }
        checking = true
        pollTimer?.invalidate()
        // 扩展每 5 秒上报一次；给 20 秒窗口，看到就转成功页
        var left = 20
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
            guard let self else { return }
            left -= 2
            self.fetchExtensionState { ok in
                if ok {
                    t.invalidate()
                    self.checking = false
                    self.renderDone()
                } else if left <= 0 {
                    t.invalidate()
                    self.checking = false
                    self.renderFailed("还没收到上报。确认扩展已「启用」，并且 \(self.browser ?? "浏览器") 里至少开着一个会话标签。")
                }
            }
        }
    }

    private func fetchExtensionState(_ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: endpoint + "/state") else { return done(false) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var ok = false
            if let d = data,
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let ext = obj["extension"] as? [String: Any],
               let live = ext["ok"] as? Bool {
                ok = live
            }
            DispatchQueue.main.async { done(ok) }
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
        checking = false
        panel?.orderOut(nil)
        panel = nil
        body = nil
        browser = nil
    }

    /// Esc / 面板关闭走这里：不写 onboarded，下次启动还会提示
    func dismissNow() {
        dismiss()
    }
}

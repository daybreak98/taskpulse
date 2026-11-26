import Foundation
import Security

/// 首次启动时把运行环境准备到用户目录：配置、密钥、uv、Python、扩展文件。
///
/// 之前这些都在 `install.command` 里做。现在同事只双击 App，App 自己完成，
/// 不需要终端、不需要预装 Python/uv，也不需要 sudo。
///
/// 所有资源都从 App Bundle 的 Resources 里取；用户数据只写 `~/.taskpulse/`
/// 与 `~/Applications/TaskPulse/edge-ext`（扩展目录路径必须稳定，否则浏览器里
/// 已加载的扩展会失效）。

enum BootstrapError: Error, CustomStringConvertible {
    /// 出错的步骤名 + 具体原因
    case step(String, String)

    var description: String {
        switch self {
        case let .step(name, reason): return "\(name)：\(reason)"
        }
    }
}

final class Bootstrap {

    struct Plan {
        let uv: String
        let poller: String
        let port: Int
        let args: [String]
    }

    /// NSHomeDirectory() 不受 HOME 环境变量影响，自检时要能把整套初始化
    /// 跑在一个假家目录里（不然会写进真实用户目录）。生产环境不设这个变量。
    static var home: String {
        ProcessInfo.processInfo.environment["TP_HOME"] ?? NSHomeDirectory()
    }
    static var stateDir: String { home + "/.taskpulse" }
    static var configPath: String { stateDir + "/config.json" }
    static var tokenPath: String { stateDir + "/token" }
    static var runtimePath: String { stateDir + "/runtime.json" }
    static var extDir: String { home + "/Applications/TaskPulse/edge-ext" }

    /// Bundle 里的资源目录（Release 构建时就是 Contents/Resources）
    static var resources: String {
        (Bundle.main.resourceURL?.path) ?? (Bundle.main.bundlePath + "/Contents/Resources")
    }

    // MARK: - 是否已经初始化过

    static func isReady() -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: configPath),
              let data = fm.contents(atPath: runtimePath),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let uv = obj["uv"] as? String,
              fm.isExecutableFile(atPath: uv),
              let poller = obj["poller"] as? String,
              fm.fileExists(atPath: poller) else {
            return false
        }
        return true
    }

    static func configuredPort(_ cfg: [String: Any]) -> Int {
        let ui = cfg["ui"] as? [String: Any] ?? [:]
        return (ui["port"] as? Int) ?? Int(ui["port"] as? String ?? "") ?? 8899
    }

    /// 已初始化时也必须同步新版浏览器协议和生成的配置，不能只换后台。
    static func refreshPaths() -> Bool {
        let fm = FileManager.default
        guard let data = fm.contents(atPath: runtimePath),
              var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let uv = obj["uv"] as? String, fm.isExecutableFile(atPath: uv),
              let raw = fm.contents(atPath: configPath),
              let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else { return false }
        let poller = resources + "/poller.py"
        guard fm.fileExists(atPath: poller) else { return false }
        do {
            let port = configuredPort(cfg)
            let token = try ensureToken()
            try syncScripts()
            try syncExtension(cfg: cfg, port: port, token: token)
            if obj["poller"] as? String != poller || obj["port"] as? Int != port {
                obj["poller"] = poller
                obj["port"] = port
                let updated = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
                try updated.write(to: URL(fileURLWithPath: runtimePath), options: .atomic)
            }
            return true
        } catch {
            dbg("刷新安装文件失败：\(error)")
            return false
        }
    }

    // MARK: - 入口

    /// 异步执行；progress 回到主线程，completion 也在主线程。
    static func run(progress: @escaping (String) -> Void,
                    completion: @escaping (Result<Plan, BootstrapError>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let report: (String) -> Void = { step in
                DispatchQueue.main.async { progress(step) }
            }
            do {
                let plan = try execute(report: report)
                DispatchQueue.main.async { completion(.success(plan)) }
            } catch let err as BootstrapError {
                DispatchQueue.main.async { completion(.failure(err)) }
            } catch {
                DispatchQueue.main.async {
                    completion(.failure(.step("未知步骤", error.localizedDescription)))
                }
            }
        }
    }

    /// 同步版，给 `--bootstrap-check` 自检用
    static func runSync(verbose: Bool = true) throws -> Plan {
        try execute(report: { if verbose { print("-- \($0)") } })
    }

    // MARK: - 实际步骤

    private static func execute(report: (String) -> Void) throws -> Plan {
        let fm = FileManager.default

        report("检查目录")
        try? fm.createDirectory(atPath: stateDir, withIntermediateDirectories: true)

        report("准备配置")
        let cfg = try ensureConfig()

        report("准备本机密钥")
        let token = try ensureToken()

        report("准备 uv")
        let uv = try ensureUV()

        report("准备 Python")
        try ensurePython(uv)

        let port = configuredPort(cfg)
        let args = readUVArgs()

        report("检查取数依赖（首次要下载，约 10-40 秒）")
        try warmUp(uv: uv, args: args)

        report("准备配套脚本")
        try syncScripts()

        report("准备浏览器扩展")
        try syncExtension(cfg: cfg, port: port, token: token)

        report("写入运行参数")
        let poller = resources + "/poller.py"
        guard fm.fileExists(atPath: poller) else {
            throw BootstrapError.step("准备后台程序", "App 里找不到 poller.py（安装包不完整）")
        }
        let plan = Plan(uv: uv, poller: poller, port: port, args: args)
        try writeRuntime(plan)
        report("完成")
        return plan
    }

    // MARK: 配置

    private static func ensureConfig() throws -> [String: Any] {
        let fm = FileManager.default
        if fm.fileExists(atPath: configPath),
           let data = fm.contents(atPath: configPath),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return obj   // 升级：沿用用户已有配置
        }
        let src = resources + "/config.json"
        guard let raw = fm.contents(atPath: src) else {
            throw BootstrapError.step("准备配置", "App 里没有 config.json（安装包不完整）")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw BootstrapError.step("准备配置", "config.json 不是合法 JSON")
        }
        do {
            try raw.write(to: URL(fileURLWithPath: configPath))
        } catch {
            throw BootstrapError.step("准备配置", "写不进 \(configPath)：\(error.localizedDescription)")
        }
        return obj
    }

    // MARK: 密钥

    private static func ensureToken() throws -> String {
        let fm = FileManager.default
        if let s = try? String(contentsOfFile: tokenPath, encoding: .utf8) {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw BootstrapError.step("准备本机密钥", "系统随机数不可用（\(status)）")
        }
        let b64 = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        do {
            try (b64 + "\n").write(toFile: tokenPath, atomically: true, encoding: .utf8)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenPath)
        } catch {
            throw BootstrapError.step("准备本机密钥", "写不进 \(tokenPath)：\(error.localizedDescription)")
        }
        return b64
    }

    // MARK: uv / Python

    private static func arch() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
        }
        return machine == "arm64" ? "aarch64" : "x86_64"
    }

    private static func ensureUV() throws -> String {
        let fm = FileManager.default
        // 1) 本机已有可用的 uv 就直接用
        for candidate in [home + "/.local/bin/uv", "/opt/homebrew/bin/uv", "/usr/local/bin/uv"] {
            if fm.isExecutableFile(atPath: candidate), runOK(candidate, ["--version"]) {
                return candidate
            }
        }
        // 2) 用 App 里带的
        let dest = home + "/.local/bin/uv"
        if fm.isExecutableFile(atPath: dest), runOK(dest, ["--version"]) {
            return dest
        }
        let gz = resources + "/vendor/uv-\(arch()).gz"
        guard fm.fileExists(atPath: gz) else {
            throw BootstrapError.step("准备 uv", "App 里没有 \(arch()) 版本的 uv")
        }
        try? fm.createDirectory(atPath: home + "/.local/bin", withIntermediateDirectories: true)
        try run("/usr/bin/gunzip", ["-c", gz], stdoutFile: dest)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dest)
        guard runOK(dest, ["--version"]) else {
            throw BootstrapError.step("准备 uv", "解压出来的 uv 跑不起来（可能被杀毒/系统拦截）")
        }
        return dest
    }

    private static func ensurePython(_ uv: String) throws {
        // 已有 >=3.10 就不动
        if runOK(uv, ["python", "find", ">=3.10"]) { return }

        let fm = FileManager.default
        let version = (try? String(contentsOfFile: resources + "/vendor/python-version.txt",
                                   encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !version.isEmpty else {
            throw BootstrapError.step("准备 Python", "App 里没有 python-version.txt")
        }
        let archive = resources + "/vendor/python-\(arch()).tar.xz"
        guard fm.fileExists(atPath: archive) else {
            throw BootstrapError.step("准备 Python", "App 里没有 \(arch()) 版本的 Python")
        }
        let base = runOutput(uv, ["python", "dir"])?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? (home + "/.local/share/uv/python")
        let target = base + "/cpython-\(version)-macos-\(arch())-none"
        try? fm.createDirectory(atPath: target, withIntermediateDirectories: true)
        try run("/usr/bin/tar", ["-xJf", archive, "-C", target])
        guard runOK(uv, ["python", "find", ">=3.10"]) else {
            throw BootstrapError.step("准备 Python", "解压后 uv 仍不认识这个运行时")
        }
    }

    private static func readUVArgs() -> [String] {
        guard let text = try? String(contentsOfFile: resources + "/uv-args.txt", encoding: .utf8) else {
            return []
        }
        return text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// 首次把 ks-aimate 拉下来。这一步要连内网源，失败就是「依赖没装好」，
    /// 单独报出来，别和「配置错了」混在一起。
    private static func warmUp(uv: String, args: [String]) throws {
        var argv = ["run", "--quiet", "--no-project", "--python", ">=3.10"]
        argv.append(contentsOf: args)
        argv.append(contentsOf: ["python", "-c", "print('ok')"])
        let p = Process()
        p.executableURL = URL(fileURLWithPath: uv)
        p.arguments = argv
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
        } catch {
            throw BootstrapError.step("检查取数依赖", "启动 uv 失败：\(error.localizedDescription)")
        }
        // 首次可能要下载几十兆，给足时间
        let deadline = Date().addingTimeInterval(180)
        while p.isRunning && Date() < deadline { usleep(120_000) }
        if p.isRunning {
            p.terminate()
            throw BootstrapError.step("检查取数依赖", "超过 3 分钟没有完成（多半是没连内网）")
        }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if p.terminationStatus != 0 {
            let tail = out.split(separator: "\n").suffix(3).joined(separator: " / ")
            throw BootstrapError.step("检查取数依赖",
                                      "装不上 ks-aimate（检查是否连了公司网络）：\(tail)")
        }
    }

    // MARK: 配套脚本

    /// 小窗里「扫码重新授权」按钮、以及各处自查，都指向安装目录里的脚本。
    private static func syncScripts() throws {
        let fm = FileManager.default
        let dest = (extDir as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: dest, withIntermediateDirectories: true)
        for name in ["api_runtime.sh", "api_login.command", "api_check.command", "health_check.sh", "uninstall.command"] {
            let from = resources + "/" + name
            guard fm.fileExists(atPath: from) else { continue }
            let to = dest + "/" + name
            if fm.isExecutableFile(atPath: to), fm.contentsEqual(atPath: from, andPath: to) { continue }
            do {
                let staged = URL(fileURLWithPath: to + "." + UUID().uuidString + ".tmp")
                defer { try? fm.removeItem(at: staged) }
                try fm.copyItem(at: URL(fileURLWithPath: from), to: staged)
                try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: staged.path)
                if fm.fileExists(atPath: to) {
                    _ = try fm.replaceItemAt(URL(fileURLWithPath: to), withItemAt: staged,
                                             options: .usingNewMetadataOnly)
                } else {
                    try fm.moveItem(at: staged, to: URL(fileURLWithPath: to))
                }
            } catch {
                throw BootstrapError.step("准备配套脚本", "\(name)：\(error.localizedDescription)")
            }
        }
    }

    // MARK: 扩展

    private static func syncExtension(cfg: [String: Any], port: Int, token: String) throws {
        let fm = FileManager.default
        let src = resources + "/edge-ext"
        guard fm.fileExists(atPath: src) else {
            throw BootstrapError.step("准备浏览器扩展", "App 里没有 edge-ext 目录")
        }
        // Read and validate the complete bundled bridge before replacing any installed file.
        var files: [(String, Data)] = []
        for name in ["background.js", "web-bridge.js", "manifest.template.json"] {
            guard let data = fm.contents(atPath: src + "/" + name), !data.isEmpty else {
                throw BootstrapError.step("准备浏览器扩展", "App 里缺少 \(name)")
            }
            files.append((name, data))
        }
        guard let raw = files.first(where: { $0.0 == "manifest.template.json" })?.1,
              let manifest = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw BootstrapError.step("准备浏览器扩展", "manifest.template.json 读不出来")
        }
        files += try extensionConfigFiles(cfg: cfg, port: port, token: token, manifest: manifest)
        try fm.createDirectory(atPath: extDir, withIntermediateDirectories: true)
        // Atomic per-file replacement keeps existing scripts intact if a write fails.
        // The stable directory is retained for the browser's unpacked-extension registration.
        for (name, data) in files {
            let to = extDir + "/" + name
            if fm.contents(atPath: to) == data { continue }
            do {
                try data.write(to: URL(fileURLWithPath: to), options: .atomic)
            } catch {
                throw BootstrapError.step("准备浏览器扩展", "\(name)：\(error.localizedDescription)")
            }
        }
    }

    private static func extensionConfigFiles(cfg: [String: Any], port: Int, token: String,
                                             manifest template: [String: Any]) throws -> [(String, Data)] {
        let plat = (cfg["platform"] as? [String: Any]) ?? [:]
        let scope = ((cfg["extension"] as? [String: Any])?["scope"] as? String) ?? ""
        let base = (plat["base_url"] as? String) ?? ""
        let prefix = (plat["api_prefix"] as? String) ?? ""
        let endpoints = (plat["endpoints"] as? [String: Any]) ?? [:]
        let bodyIn = (plat["conversations_body"] as? [String: Any]) ?? [:]
        let qf = (plat["queue_fields"] as? [String: Any]) ?? [:]
        let agentIds = (plat["agent_ids"] as? [Any]) ?? []

        // 会话页前缀：conversation_url 去掉查询串和占位符
        var convPage = ""
        if let tpl = plat["conversation_url"] as? String, !tpl.isEmpty {
            var head = tpl.split(separator: "?").first.map(String.init) ?? tpl
            head = head.replacingOccurrences(of: "{host}", with: base.trimmingTrailingSlash())
            for mark in ["{", "}"] {
                if let r = head.range(of: mark), r.lowerBound != head.startIndex {
                    head = String(head[head.startIndex..<r.lowerBound])
                }
            }
            convPage = head.trimmingTrailingSlash()
        }

        var body: [String: Any] = [:]
        for (k, v) in bodyIn {
            if let s = v as? String, s == "{agent_ids}" {
                body[k] = agentIds
            } else {
                body[k] = v
            }
        }

        let api: [String: Any] = [
            "convPage": convPage,
            "prefix": prefix,
            "conv": (endpoints["conversations"] as? String) ?? "",
            "queue": (endpoints["queue"] as? String) ?? "",
            "messages": (endpoints["messages"] as? String) ?? "",
            "state": (qf["state"] as? String) ?? "state",
            "pending": (qf["pending"] as? String) ?? "",
            "idle": (qf["idle"] as? [Any]) ?? [],
            "body": body,
            "marks": (cfg["failure_marks"] as? [Any]) ?? []
        ]

        let configJS: [String: Any] = [
            "scope": scope,
            "port": port,
            "token": token,
            "api": scope.isEmpty ? NSNull() : api
        ]
        guard let encodedConfig = jsonString(configJS) else {
            throw BootstrapError.step("准备浏览器扩展", "config.js 生成失败")
        }
        let js = "// 由 TaskPulse.app 按配置生成，重新打开 App 会覆盖\n"
            + "self.TP_CONFIG = " + encodedConfig + ";\n"

        // manifest：模板 + 端口/域名
        var manifest = template
        var hosts = ["http://127.0.0.1:\(port)/*"]
        if !scope.isEmpty { hosts.append(scope) }
        manifest["host_permissions"] = hosts
        guard let mData = try? JSONSerialization.data(withJSONObject: manifest,
                                                      options: [.prettyPrinted, .sortedKeys,
                                                                .withoutEscapingSlashes]) else {
            throw BootstrapError.step("准备浏览器扩展", "manifest 生成失败")
        }
        return [("config.js", Data(js.utf8)), ("manifest.json", mData)]
    }

    // MARK: 运行参数

    private static func writeRuntime(_ plan: Plan) throws {
        let obj: [String: Any] = [
            "uv": plan.uv,
            "poller": plan.poller,
            "port": plan.port,
            "args": plan.args
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: obj,
                                                     options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            throw BootstrapError.step("写入运行参数", "序列化失败")
        }
        try writeFile(text, to: runtimePath)
    }

    // MARK: 小工具

    private static func writeFile(_ text: String, to path: String) throws {
        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
        } catch {
            throw BootstrapError.step("写文件", "\(path)：\(error.localizedDescription)")
        }
    }

    private static func jsonString(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj,
                                                     options: [.sortedKeys, .withoutEscapingSlashes]),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }

    private static func runOK(_ exe: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    private static func runOutput(_ exe: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }

    /// 直接把命令输出写到文件（解压用，避免几十兆数据经过内存）
    private static func run(_ exe: String, _ args: [String], stdoutFile: String) throws {
        FileManager.default.createFile(atPath: stdoutFile, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: stdoutFile) else {
            throw BootstrapError.step("解压", "打不开 \(stdoutFile)")
        }
        defer { try? handle.close() }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.standardOutput = handle
        let err = Pipe()
        p.standardError = err
        do { try p.run() } catch {
            throw BootstrapError.step("解压", "启动 \(exe) 失败：\(error.localizedDescription)")
        }
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(),
                             encoding: .utf8) ?? ""
            throw BootstrapError.step("解压", msg.isEmpty ? "命令返回 \(p.terminationStatus)" : msg)
        }
    }

    private static func run(_ exe: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let err = Pipe()
        p.standardError = err
        p.standardOutput = Pipe()
        do { try p.run() } catch {
            throw BootstrapError.step("解压", "启动 \(exe) 失败：\(error.localizedDescription)")
        }
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(),
                             encoding: .utf8) ?? ""
            throw BootstrapError.step("解压", msg.isEmpty ? "命令返回 \(p.terminationStatus)" : msg)
        }
    }
}

private extension String {
    func trimmingTrailingSlash() -> String {
        var s = self
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

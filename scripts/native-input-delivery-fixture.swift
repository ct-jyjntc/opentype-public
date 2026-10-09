// Disposable AppKit editor for testing the production Electron -> AX bridge.
// Actions come from the visible buttons; no automated keyboard/mouse synthesis.
import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var editor: NSTextView!
    let directory = URL(fileURLWithPath: CommandLine.arguments[1])
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(), appMenu = NSMenu(), item = NSMenuItem()
        appMenu.addItem(withTitle: "退出测试编辑器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item)
        let edit = NSMenuItem(), editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu = editMenu; menu.addItem(edit); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 360, y: 260, width: 680, height: 360), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "OpenType 原生交付测试"; window.isReleasedWhenClosed = false
        let content = window.contentView!
        let label = NSTextField(labelWithString: CommandLine.arguments.contains("--simulate-correction")
            ? "模拟纠错测试：点击捕获后，测试窗口会自动聚焦并改正合成错词。不是真人打字或语音验收。"
            : "仅使用此临时编辑器中的合成文字。选中表情后点击捕获，再切换到 Electron 交付。")
        label.frame = NSRect(x: 20, y: 300, width: 640, height: 40); label.maximumNumberOfLines = 2; content.addSubview(label)
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 100, width: 640, height: 190))
        editor = NSTextView(frame: scroll.bounds)
        editor.isRichText = false; editor.font = NSFont.systemFont(ofSize: 24); editor.string = "Native🙂After"
        editor.autoresizingMask = [.width]; scroll.documentView = editor; scroll.hasVerticalScroller = true; content.addSubview(scroll)
        let capture = NSButton(title: "捕获此输入框", target: self, action: #selector(captureTarget))
        capture.frame = NSRect(x: 20, y: 35, width: 180, height: 40); content.addSubview(capture)
        let deliver = NSButton(title: "交付测试文字", target: self, action: #selector(deliverTarget))
        deliver.frame = NSRect(x: 220, y: 35, width: 180, height: 40); content.addSubview(deliver)
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(editor)
        NSApp.activate(ignoringOtherApps: true)
    }
    func send(_ action: String) {
        let data = try! JSONSerialization.data(withJSONObject: ["action": action, "pid": ProcessInfo.processInfo.processIdentifier, "request": UUID().uuidString, "foregroundPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0])
        try! data.write(to: directory.appendingPathComponent("native-request.json"), options: .atomic)
    }
    @objc func captureTarget() {
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(editor); NSApp.activate(ignoringOtherApps: true)
        if CommandLine.arguments.contains("--simulate-correction") {
            // CUA may restore its caller as foreground after an action. This
            // explicitly labelled fixture scenario activates its own test
            // window after that action and simulates an in-app text edit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.window.makeKeyAndOrderFront(nil); self.window.makeFirstResponder(self.editor); NSApp.activate(ignoringOtherApps: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.send("capture") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    let before = "Please use Opentipe and SenceVoice today."
                    let after = "Please use OpenType and SenseVoice today."
                    let range = (self.editor.string as NSString).range(of: before)
                    guard range.location != NSNotFound else { return }
                    self.editor.insertText(after, replacementRange: range)
                }
            }
        } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.send("capture") } }
    }
    @objc func deliverTarget() {
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.send("deliver") }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let fixture = Fixture()
app.setActivationPolicy(.regular); app.delegate = fixture; app.run()

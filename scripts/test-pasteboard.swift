import AppKit

@main
struct PasteboardTests {
    static func main() {
        // A private named pasteboard: never read or change the user's clipboard.
        let pb = NSPasteboard(name: NSPasteboard.Name("opentype-test-\(UUID())"))
        defer { pb.releaseGlobally() }
        let restorer = PasteboardRestorer(pb)
        func write(_ text: String) { pb.clearContents(); pb.setString(text, forType: .string) }
        func insert(_ text: String) -> UUID {
            let original = restorer.capture()
            write(text)
            return restorer.didWrite(original: original)
        }

        write("original")
        pb.setString("<b>original</b>", forType: .html)
        let richOriginal = archivePasteboard(pb)
        let first = insert("temporary")
        restorer.restoreIfOwned(first)
        precondition(archivePasteboard(pb) == richOriginal, "Must restore all clipboard formats")

        let changed = insert("temporary")
        write("new user copy")
        restorer.restoreIfOwned(changed)
        precondition(pb.string(forType: .string) == "new user copy", "Must preserve a newer copy")

        write("base")
        let a = insert("first insertion"), b = insert("second insertion")
        restorer.restoreIfOwned(a)
        precondition(pb.string(forType: .string) == "second insertion", "Old timer must not interrupt second paste")
        restorer.restoreIfOwned(b)
        precondition(pb.string(forType: .string) == "base", "Rapid pastes must restore the original clipboard")

        let c = insert("temporary")
        write("user changed between pastes")
        let d = insert("second temporary")
        restorer.restoreIfOwned(c)
        restorer.restoreIfOwned(d)
        precondition(pb.string(forType: .string) == "user changed between pastes")

        pb.clearContents()
        let empty = insert("temporary")
        restorer.restoreIfOwned(empty)
        precondition((pb.pasteboardItems ?? []).isEmpty, "Originally empty clipboard must stay empty")
        print("Pasteboard restoration: 6 assertions passed (private pasteboard)")
    }
}

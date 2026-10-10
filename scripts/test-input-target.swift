import Foundation
import ApplicationServices
@main struct InputTargetTests {
    static func main() {
        precondition(expectedInsertion("Hi🙂你好", CFRange(location: 2, length: 2), "OpenType") == "HiOpenType你好")
        precondition(expectedInsertion("Hi🙂你好", CFRange(location: 6, length: 0), "！") == "Hi🙂你好！")
        precondition(expectedInsertion("Hi🙂你好", CFRange(location: 3, length: 0), "x") == nil)
        precondition(expectedInsertion("Hi🙂你好", CFRange(location: 2, length: 1), "x") == nil)
        precondition(expectedInsertion("abc", CFRange(location: -1, length: 1), "x") == nil)
        precondition(expectedInsertion("abc", CFRange(location: 2, length: Int.max), "x") == nil)
        precondition(expectedInsertion("", CFRange(location: 0, length: 0), "中文\n🙂") == "中文\n🙂")
        precondition(expectedInsertion("e\u{301} hello", CFRange(location: 0, length: 2), "é") == "é hello")
        precondition(inputTargetURL("https://example.test/editor" as CFString) == "https://example.test/editor")
        precondition(inputTargetURL(NSURL(string: "https://example.test/editor")!) == "https://example.test/editor")
        precondition(inputTargetURL(nil) == nil)
        precondition(inputTargetURL(NSNumber(value: 42)) == nil)
        precondition(observedInsertion("前🙂后", CFRange(location: 1, length: 2), "前OpenType后") == "OpenType")
        precondition(observedInsertion("prefix suffix", CFRange(location: 7, length: 0), "prefix SenseVoice suffix") == "SenseVoice ")
        precondition(observedInsertion("prefix suffix", CFRange(location: 7, length: 0), "changed SenseVoice suffix") == nil)
        precondition(observedInsertion("prefix suffix", CFRange(location: 7, length: 0), "prefix SenseVoice changed") == nil)
        precondition(observedInsertion("abc", CFRange(location: 0, length: 3), "OpenType\n🙂") == "OpenType\n🙂")
        precondition(observedInsertion("abcd", CFRange(location: 1, length: 1), "a") == nil)
        precondition(observedInsertion("Hi🙂你好", CFRange(location: 3, length: 0), "Hi🙂你好") == nil)
        precondition(observedInsertion("", CFRange(location: 0, length: 0), String(repeating: "a", count: 100_001)) == nil)
        precondition(keyCode(forCharacter: "v") != nil)
        print("PASS native UTF-16 insertion, selected replacement, empty/multiline/emoji, invalid range protection and AX URL representations")
    }
}

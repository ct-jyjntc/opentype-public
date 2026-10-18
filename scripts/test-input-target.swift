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
        precondition(inputVerificationStatus(.cannotComplete, nil, "dictated") == "pending")
        precondition(inputVerificationStatus(.noValue, nil, "dictated") == "pending")
        precondition(inputVerificationStatus(.success, "dictated", "dictated") == "verified")
        precondition(inputVerificationStatus(.success, "old text", "dictated") == "pending")
        precondition(inputVerificationStatus(.invalidUIElement, nil, "dictated") == "unverified")
        precondition(inputVerificationStatus(.success, nil, "dictated") == "unverified")
        precondition(inputReadPending(.cannotComplete))
        precondition(inputReadPending(.noValue))
        precondition(!inputReadPending(.invalidUIElement))
        precondition(TextInjector.keyCode(forCharacter: "v") != nil)
        print("PASS native UTF-16 insertion, selected replacement, empty/multiline/emoji, invalid range protection, AX URL representations and transient paste verification")
    }
}

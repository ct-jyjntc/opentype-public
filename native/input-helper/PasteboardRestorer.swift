import AppKit

typealias PasteboardArchive = [[String: Data]]

func archivePasteboard(_ pb: NSPasteboard) -> PasteboardArchive {
    return (pb.pasteboardItems ?? []).compactMap { item in
        var entry: [String: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) { entry[type.rawValue] = data }
        }
        return entry.isEmpty ? nil : entry
    }
}

func restorePasteboard(_ archive: PasteboardArchive, to pb: NSPasteboard) {
    pb.clearContents()
    let items = archive.map { entry -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in entry { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
        return item
    }
    if !items.isEmpty { pb.writeObjects(items) }
}

/// A delayed paste may restore only the clipboard version it wrote. Multiple rapid
/// insertions share the original archive instead of restoring each other's temporary text.
final class PasteboardRestorer {
    private let pasteboard: NSPasteboard
    private var pending: (token: UUID, changeCount: Int, archive: PasteboardArchive)?

    init(_ pasteboard: NSPasteboard) { self.pasteboard = pasteboard }

    func capture() -> PasteboardArchive {
        if let pending, pasteboard.changeCount == pending.changeCount { return pending.archive }
        pending = nil
        return archivePasteboard(pasteboard)
    }

    func didWrite(original: PasteboardArchive) -> UUID {
        let token = UUID()
        pending = (token, pasteboard.changeCount, original)
        return token
    }

    func restoreIfOwned(_ token: UUID) {
        guard let current = pending, current.token == token else { return }
        pending = nil
        guard pasteboard.changeCount == current.changeCount else { return }
        restorePasteboard(current.archive, to: pasteboard)
    }
}

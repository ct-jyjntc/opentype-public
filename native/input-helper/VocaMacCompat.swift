// VocaMacCompat.swift
//
// Minimal stand-ins for the VocaMac services that TextInjector.swift refers to,
// so that file can stay as close as possible to upstream VocaMac
// (https://github.com/VocaHQ/vocamac, AGPL-3.0). OpenType records delivery
// diagnostics in its main process instead, so logging and tracing are no-ops.

import Foundation

enum VocaLogCategory { case textInjector }

enum VocaLogger {
    static func debug(_ category: VocaLogCategory, _ message: @autoclosure () -> String) {}
    static func info(_ category: VocaLogCategory, _ message: @autoclosure () -> String) {}
    static func warning(_ category: VocaLogCategory, _ message: @autoclosure () -> String) {}
    static func error(_ category: VocaLogCategory, _ message: @autoclosure () -> String) {}
}

enum PerformanceTrace {
    struct Interval: Sendable {}
    static func begin(_ name: StaticString) -> Interval { Interval() }
    static func end(_ interval: Interval) {}
    static func event(_ name: StaticString) {}
}

protocol TextInjecting {}

/// How one delivery ended, reported to OpenType's input-target token API.
/// `pasted` means Cmd+V was posted; the clipboard restore continues afterwards.
enum DeliveryOutcome: Sendable {
    case accessibility
    case uncertain
    case pasted
    case failed(String)
}

typealias DeliveryReport = @Sendable (DeliveryOutcome) -> Void

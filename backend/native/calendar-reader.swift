import EventKit
import Foundation

let helperVersion = "2"
let helperIdentity = "com.lshu.workbench.calendar-reader"

struct Envelope: Codable {
    var ok: Bool
    var version: String
    var permission: String
    var requestedAccess: Bool
    var truncated: Bool
    var errorCode: String?
    var errorMessage: String?
    var identity: String?
    var events: [EventDTO]
}

struct EventDTO: Codable {
    var calendarIdentifier: String
    var calendarName: String
    var eventIdentifier: String
    var occurrenceStartAt: String
    var startAt: String
    var endAt: String
    var title: String
    var allDay: Bool
    var allDayLocalStart: String?
    var allDayLocalEnd: String?
    var availability: String
    var calendarType: String
    var ownedByWorkbench: Bool
    var timezone: String
}

func iso(_ date: Date) -> String {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fmt.string(from: date)
}

func parseISODate(_ raw: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: raw) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let date = plain.date(from: raw) { return date }
    return nil
}

struct ISOParseError: Error {
    let message: String
}

func parseRequiredISO(_ raw: String, field: String) -> Result<Date, ISOParseError> {
    if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return .failure(ISOParseError(message: "\(field): missing"))
    }
    if let date = parseISODate(raw) { return .success(date) }
    return .failure(ISOParseError(message: "\(field): invalid ISO8601"))
}

func permissionString(_ status: EKAuthorizationStatus) -> String {
    if #available(macOS 14.0, *) {
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .fullAccess: return "fullAccess"
        case .writeOnly: return "writeOnly"
        default: return "unknown"
        }
    }
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "fullAccess"
    default: return "unknown"
    }
}

func availabilityString(_ value: EKEventAvailability) -> String {
    switch value {
    case .free: return "free"
    case .tentative: return "tentative"
    case .unavailable: return "unavailable"
    default: return "busy"
    }
}

func calendarTypeString(_ cal: EKCalendar) -> String {
    switch cal.type {
    case .birthday: return "birthday"
    case .subscription: return "subscription"
    default: return "standard"
    }
}

func emit(_ env: Envelope) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(env), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

func emptyEnvelope(ok: Bool, permission: String, requestedAccess: Bool, errorCode: String?, errorMessage: String?) -> Envelope {
    Envelope(
        ok: ok,
        version: helperVersion,
        permission: permission,
        requestedAccess: requestedAccess,
        truncated: false,
        errorCode: errorCode,
        errorMessage: errorMessage,
        identity: helperIdentity,
        events: []
    )
}

let args = CommandLine.arguments

if args.contains("--version") || args.contains("--identity") {
    emit(emptyEnvelope(ok: true, permission: "unknown", requestedAccess: false, errorCode: nil, errorMessage: nil))
    exit(0)
}

if args.contains("--self-test-dates") {
    let cases: [(String, Bool)] = [
        ("2026-08-23T16:00:00.000Z", true),
        ("2026-08-23T16:00:00Z", true),
        ("2026-08-24T00:00:00+08:00", true),
        ("not-a-date", false),
    ]
    var results: [[String: Any]] = []
    var passed = true
    for (input, expectOk) in cases {
        let ok = parseISODate(input) != nil
        if ok != expectOk { passed = false }
        results.append(["input": input, "expectOk": expectOk, "ok": ok])
    }
    let payload: [String: Any] = [
        "ok": passed,
        "version": helperVersion,
        "identity": helperIdentity,
        "results": results,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
    exit(passed ? 0 : 1)
}

let requestAccess = args.contains("--request-access")
var fromISO = ""
var toISO = ""
var tzName = "Asia/Shanghai"
if let i = args.firstIndex(of: "--from"), i + 1 < args.count { fromISO = args[i + 1] }
if let i = args.firstIndex(of: "--to"), i + 1 < args.count { toISO = args[i + 1] }
if let i = args.firstIndex(of: "--timezone"), i + 1 < args.count { tzName = args[i + 1] }

switch parseRequiredISO(fromISO, field: "from") {
case .failure(let err):
    emit(emptyEnvelope(ok: false, permission: "unknown", requestedAccess: requestAccess, errorCode: "VALIDATION_ERROR", errorMessage: err.message))
    exit(0)
case .success(let from):
    switch parseRequiredISO(toISO, field: "to") {
    case .failure(let err):
        emit(emptyEnvelope(ok: false, permission: "unknown", requestedAccess: requestAccess, errorCode: "VALIDATION_ERROR", errorMessage: err.message))
        exit(0)
    case .success(let to):
        let store = EKEventStore()
        var status = EKEventStore.authorizationStatus(for: .event)
        let needsRequest: Bool
        if #available(macOS 14.0, *) {
            needsRequest = status == .notDetermined || status == .writeOnly
        } else {
            needsRequest = status == .notDetermined
        }
        if requestAccess && needsRequest {
            let sem = DispatchSemaphore(value: 0)
            if #available(macOS 14.0, *) {
                store.requestFullAccessToEvents { _, _ in
                    sem.signal()
                }
            } else {
                store.requestAccess(to: .event) { _, _ in
                    sem.signal()
                }
            }
            _ = sem.wait(timeout: .now() + 20)
            status = EKEventStore.authorizationStatus(for: .event)
        }
        let perm = permissionString(status)
        if perm != "fullAccess" {
            let code: String
            let message: String
            switch perm {
            case "writeOnly":
                code = "CALENDAR_WRITE_ONLY"
                message = "仅有写入权限，需要完整访问。请在系统设置 → 隐私与安全性 → 日历中开启完全访问。"
            case "denied", "restricted":
                code = "CALENDAR_PERMISSION_DENIED"
                message = "已拒绝日历访问。请打开系统设置 → 隐私与安全性 → 日历，为 L叔工作台日历读取器打开完全访问。"
            case "notDetermined":
                code = "CALENDAR_PERMISSION_DENIED"
                message = "尚未授权日历完整访问。"
            default:
                code = "CALENDAR_PERMISSION_DENIED"
                message = "无法读取日历。"
            }
            emit(emptyEnvelope(ok: false, permission: perm, requestedAccess: requestAccess, errorCode: code, errorMessage: message))
            exit(0)
        }

        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        let events = store.events(matching: predicate)
        var out: [EventDTO] = []
        let tz = TimeZone(identifier: tzName) ?? TimeZone.current
        let dayFmt = DateFormatter()
        dayFmt.calendar = Calendar(identifier: .gregorian)
        dayFmt.timeZone = tz
        dayFmt.dateFormat = "yyyy-MM-dd"

        for ev in events {
            if ev.status == EKEventStatus.canceled { continue }
            guard let calendar = ev.calendar else { continue }
            let ident = calendar.calendarIdentifier
            let eid = ev.eventIdentifier ?? ev.calendarItemIdentifier
            if ident.isEmpty || eid.isEmpty { continue }
            let start = ev.startDate ?? from
            let end = ev.endDate ?? start
            let owned = calendar.title == "L叔工作台"
            out.append(EventDTO(
                calendarIdentifier: ident,
                calendarName: calendar.title,
                eventIdentifier: eid,
                occurrenceStartAt: iso(start),
                startAt: iso(start),
                endAt: iso(end),
                title: ev.title ?? "",
                allDay: ev.isAllDay,
                allDayLocalStart: ev.isAllDay ? dayFmt.string(from: start) : nil,
                allDayLocalEnd: ev.isAllDay ? dayFmt.string(from: end) : nil,
                availability: availabilityString(ev.availability),
                calendarType: calendarTypeString(calendar),
                ownedByWorkbench: owned,
                timezone: tz.identifier
            ))
        }

        emit(Envelope(
            ok: true,
            version: helperVersion,
            permission: perm,
            requestedAccess: requestAccess,
            truncated: false,
            errorCode: nil,
            errorMessage: nil,
            identity: helperIdentity,
            events: out
        ))
    }
}

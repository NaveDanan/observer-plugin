import { describe, expect, it } from "vitest"
import { relativeTime } from "../src/relativeTime"

const NOW = new Date("2026-06-15T12:00:00Z").getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("relativeTime", () => {
  it("calls anything inside the last minute 'just now'", () => {
    expect(relativeTime(NOW, NOW).label).toBe("just now")
    expect(relativeTime(NOW - 59_000, NOW).label).toBe("just now")
  })

  it("treats a future timestamp as 'just now' rather than counting up", () => {
    // The daemon's host and this browser can disagree by a few seconds.
    // "in 3s" would read as a bug in Observer, not as clock skew.
    expect(relativeTime(NOW + 5_000, NOW).label).toBe("just now")
  })

  it("counts whole minutes, then whole hours, then whole days", () => {
    expect(relativeTime(NOW - MINUTE, NOW).label).toBe("1m ago")
    expect(relativeTime(NOW - 59 * MINUTE, NOW).label).toBe("59m ago")
    expect(relativeTime(NOW - HOUR, NOW).label).toBe("1h ago")
    expect(relativeTime(NOW - 23 * HOUR, NOW).label).toBe("23h ago")
    expect(relativeTime(NOW - DAY, NOW).label).toBe("1d ago")
    expect(relativeTime(NOW - 6 * DAY, NOW).label).toBe("6d ago")
  })

  it("truncates rather than rounds, so a label never claims time that has not passed", () => {
    expect(relativeTime(NOW - (90 * MINUTE), NOW).label).toBe("1h ago")
  })

  it("hands over to an absolute date past a week", () => {
    // "63d ago" locates nothing; a date does.
    const label = relativeTime(NOW - 8 * DAY, NOW).label
    expect(label).not.toMatch(/ago/)
    expect(label).toMatch(/\d/)
  })

  it("drops the year inside the current one and keeps it outside", () => {
    const thisYear = relativeTime(new Date("2026-01-05T00:00:00Z").getTime(), NOW).label
    const lastYear = relativeTime(new Date("2025-01-05T00:00:00Z").getTime(), NOW).label
    expect(thisYear).not.toMatch(/2026/)
    expect(lastYear).toMatch(/2025/)
  })

  it("always carries the exact timestamp alongside the short form", () => {
    const result = relativeTime(NOW - 5 * MINUTE, NOW)
    expect(result.label).toBe("5m ago")
    expect(result.absolute).toBe(new Date(NOW - 5 * MINUTE).toLocaleString())
  })
})

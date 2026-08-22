import { describe, expect, it } from "vitest"
import { churnSummary, churnTitle } from "../src/churn"

describe("churn: absent is not zero", () => {
  it("renders nothing when the reducer recorded no edit at all", () => {
    // The rule the UI is most likely to get wrong. An Agent that only read
    // files carries neither field, and must show no badge — a `+0 -0` here
    // would claim a measurement that was never taken.
    expect(churnSummary({})).toBeNull()
    expect(churnSummary({ linesAdded: undefined, linesRemoved: undefined })).toBeNull()
  })

  it("still renders nothing when a provenance arrived without any figures", () => {
    // Provenance alone is not a measurement, so it cannot conjure a badge.
    expect(churnSummary({ churnConfidence: "inferred" })).toBeNull()
  })

  it("renders +0 -0 for edits that cancelled out", () => {
    // The other half of the same rule, and the reason the protocol made these
    // fields optional rather than nullable: this Agent genuinely rewrote
    // files, and zero net change is a real result worth showing.
    const churn = churnSummary({ linesAdded: 0, linesRemoved: 0 })
    expect(churn).not.toBeNull()
    expect(churn?.text).toBe("+0 -0")
  })

  it("keeps the signs in the text so colour is never the only carrier", () => {
    const churn = churnSummary({ linesAdded: 128, linesRemoved: 34 })
    expect(churn?.added).toBe("+128")
    expect(churn?.removed).toBe("-34")
    expect(churn?.text).toBe("+128 -34")
  })

  it("omits a half the host never reported rather than substituting a zero", () => {
    const churn = churnSummary({ linesAdded: 12 })
    expect(churn?.added).toBe("+12")
    expect(churn?.removed).toBeNull()
    expect(churn?.text).toBe("+12")
    expect(churn?.label).toBe("12 lines added")
  })
})

describe("churn: provenance", () => {
  it("treats an authoritative total as fact and marks nothing", () => {
    const churn = churnSummary({ linesAdded: 9, linesRemoved: 1, churnConfidence: "authoritative" })
    expect(churn?.inferred).toBe(false)
    expect(churnTitle(churn!)).toBe("9 lines added, 1 removed")
  })

  it("marks anything weaker, so a guess is not presented as a measurement", () => {
    for (const level of ["inferred", "reconciled"] as const) {
      const churn = churnSummary({ linesAdded: 9, linesRemoved: 1, churnConfidence: level })
      expect(churn?.inferred).toBe(true)
      expect(churnTitle(churn!)).toContain(level)
    }
  })

  it("does not claim confidence the reducer never stated", () => {
    const churn = churnSummary({ linesAdded: 9, linesRemoved: 1, churnConfidence: null })
    expect(churn?.provenance).toBeNull()
    expect(churn?.inferred).toBe(false)
  })
})

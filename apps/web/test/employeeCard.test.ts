import { describe, expect, it } from "vitest"
import { ROSTER } from "@observer-ai/roster"
import type { RosterProfile } from "@observer-ai/roster"
import {
  CARD_LAYOUT,
  MAX_ROLE_CHARACTERS,
  PHOTO_BACKDROP_FALLBACK,
  cardCssVariables,
  employeeCardContent,
  employeeNumber,
  estimateTextWidth,
  fitFontSize,
  trackedTextWidth,
  formatDisplayName,
  formatEmployeeId,
  getAccessLevel,
  inferDepartment,
  photoBackdropGradient,
  photoImageBox,
  pillTextWidth,
  scaledFontSize,
  shortRoleTitle,
} from "../src/employeeCard"

/**
 * The card is drawn from the real roster, so the tests are too. Every case
 * below that says "all eight" means it: a spot-check would have missed
 * "Principal Technical Program Manager", which is the only title long enough
 * to break the pill.
 */
const EMPLOYEES: RosterProfile[] = ROSTER

function profileFor(id: string): RosterProfile {
  const profile = EMPLOYEES.find((entry) => entry.id === id)
  if (!profile) throw new Error(`no roster profile ${id}`)
  return profile
}

describe("card layout", () => {
  it("holds the template's own raster size, which every other number divides by", () => {
    expect(CARD_LAYOUT.width).toBe(1023)
    expect(CARD_LAYOUT.height).toBe(1537)
  })

  it("derives the portrait box from photoZoom rather than restating it", () => {
    // 0.80 of cover for a square source in a 418x574 frame: 574 * 0.8.
    const box = photoImageBox()
    expect(box.width).toBeCloseTo(459.2, 4)
    expect(box.height).toBeCloseTo(459.2, 4)
  })

  it("pins the portrait's height to exactly photoZoom of the frame", () => {
    // The frame is taller than it is wide, so cover is height-driven and the
    // vertical percentage collapses to photoZoom exactly. The reference
    // stylesheet hardcoded 79.97%, which is this number rounded by hand.
    const box = photoImageBox()
    expect(box.height / CARD_LAYOUT.photo.height).toBeCloseTo(CARD_LAYOUT.photoZoom, 10)
  })

  it("emits every position as a percentage of the card box", () => {
    const vars = cardCssVariables()
    expect(vars["--nj-photo-left"]).toBe("10.948192%")
    expect(vars["--nj-photo-top"]).toBe("31.620039%")
    expect(vars["--nj-photo-width"]).toBe("40.860215%")
    expect(vars["--nj-photo-height"]).toBe("37.345478%")
    expect(vars["--nj-pill-left"]).toBe("63.734115%")
    expect(vars["--nj-pill-width"]).toBe("26.099707%")
    expect(vars["--nj-name-left"]).toBe("57.673509%")
    expect(vars["--nj-name-top"]).toBe("32.856213%")
  })

  it("places the four pill rows in the order the template paints them", () => {
    const vars = cardCssVariables()
    const tops = [
      vars["--nj-pill-role-top"],
      vars["--nj-pill-department-top"],
      vars["--nj-pill-employeeId-top"],
      vars["--nj-pill-accessLevel-top"],
    ].map((value) => Number.parseFloat(value!))
    expect(tops).toEqual([...tops].sort((a, b) => a - b))
  })

  it("puts each row on the centre line the template actually paints", () => {
    // Measured off the raster, not copied from the reference: rows 3 and 4
    // were 4-5px high in every renderer this was ported from.
    const centres = Object.values(CARD_LAYOUT.pillRows).map((top) => top + CARD_LAYOUT.pill.height / 2)
    expect(centres).toEqual([699, 822, 939, 1057])
  })

  it("keeps the pill's line box and its height the same length", () => {
    // The pill centres text with a line box so ellipsis works. The line is a
    // ratio of the card width and the height is a percentage of the card
    // height; the aspect ratio has to make them agree or text sits off-centre.
    const vars = cardCssVariables()
    const lineOfWidth = Number.parseFloat(vars["--nj-pill-line"]!)
    const heightOfHeight = Number.parseFloat(vars["--nj-pill-height"]!) / 100
    const aspect = Number.parseFloat(vars["--nj-aspect"]!)
    expect(lineOfWidth).toBeCloseTo(heightOfHeight / aspect, 4)
  })

  it("expresses a template-pixel font size as a multiple of the card width", () => {
    expect(scaledFontSize(52)).toBe("calc(var(--nj-card-w) * 0.050831)")
  })
})

describe("text fitting", () => {
  it("leaves text that already fits at full size", () => {
    expect(fitFontSize("ID: 10415", { maxWidth: 1000, maxFontSize: 22, minFontSize: 12 })).toBe(22)
  })

  it("solves the size in one measurement, because advances are linear", () => {
    const measure = (text: string, size: number): number => text.length * size
    // 10 characters, 100px available, 22px asked for: 10px fits exactly.
    expect(fitFontSize("0123456789", { maxWidth: 100, maxFontSize: 22, minFontSize: 1, measure })).toBe(10)
  })

  it("never returns a size below the floor", () => {
    const measure = (text: string, size: number): number => text.length * size * 100
    expect(fitFontSize("wide", { maxWidth: 1, maxFontSize: 22, minFontSize: 12, measure })).toBe(12)
  })

  it("rounds down to a half pixel rather than up", () => {
    const measure = (text: string, size: number): number => size * 3
    // 22 * (65/66) = 21.666..., which floors to 21.5 and not 22.
    expect(fitFontSize("x", { maxWidth: 65, maxFontSize: 22, minFontSize: 1, measure })).toBe(21.5)
  })

  it("measures wide and narrow glyphs differently", () => {
    expect(estimateTextWidth("MMMM", 10)).toBeGreaterThan(estimateTextWidth("llll", 10))
  })

  it("counts the tracking the stylesheet applies", () => {
    // The reference measured strings without letter-spacing and then rendered
    // them with it, so its pills ran wider than anything had checked.
    const measure = (text: string, size: number): number => text.length * size
    const tight = fitFontSize("abcd", { maxWidth: 40, maxFontSize: 10, minFontSize: 1, measure })
    const tracked = fitFontSize("abcd", {
      maxWidth: 40,
      maxFontSize: 10,
      minFontSize: 1,
      letterSpacing: 0.25,
      measure,
    })
    expect(tight).toBe(10)
    expect(tracked).toBeLessThan(tight)
  })
})

describe("role titles", () => {
  it("keeps a title the card can already set", () => {
    expect(shortRoleTitle("Product Director")).toBe("Product Director")
    expect(shortRoleTitle("Staff Backend Engineer")).toBe("Staff Backend Engineer")
  })

  it("uses the reference's hand-written short forms", () => {
    expect(shortRoleTitle("Chief Technology Officer")).toBe("CTO")
    expect(shortRoleTitle("Chief Information Security Officer")).toBe("CISO")
    expect(shortRoleTitle("Vice President of Data and Analytics")).toBe("VP Data & Analytics")
    expect(shortRoleTitle("Senior DevOps and Site Reliability Engineer")).toBe("Senior DevOps / SRE")
    expect(shortRoleTitle("Principal Electronics and Hardware Engineer")).toBe("Principal Hardware Eng.")
  })

  it("shortens the longest title on the roster, which the reference clipped", () => {
    expect(shortRoleTitle("Principal Technical Program Manager")).toBe("Principal TPM")
  })

  it("squeezes generically, least-lossy first", () => {
    expect(shortRoleTitle("Senior Frontend Engineer")).toBe("Senior Frontend Eng.")
    expect(shortRoleTitle("Senior Cybersecurity Engineer")).toBe("Sr. Cybersecurity Eng.")
    expect(shortRoleTitle("Senior QA Automation Engineer")).toBe("Sr. QA Automation Eng.")
  })

  it("fits every one of the eight roles on one line", () => {
    for (const profile of EMPLOYEES) {
      expect(shortRoleTitle(profile.title).length, profile.id).toBeLessThanOrEqual(MAX_ROLE_CHARACTERS)
    }
  })
})

describe("display names", () => {
  it("drops the honorific the card has no room for", () => {
    expect(formatDisplayName("Dr. Maya Shapiro")).toEqual(["Maya", "Shapiro"])
    expect(formatDisplayName("Dr. Maya Chen")).toEqual(["Maya", "Chen"])
  })

  it("splits an ordinary name into two lines", () => {
    expect(formatDisplayName("Noam Cohen")).toEqual(["Noam", "Cohen"])
  })

  it("groups everything but the surname onto the first line", () => {
    expect(formatDisplayName("Maria del Carmen Ruiz")).toEqual(["Maria del Carmen", "Ruiz"])
  })

  it("never returns more than two lines, for anyone on the roster", () => {
    for (const profile of EMPLOYEES) {
      expect(formatDisplayName(profile.fullName).length, profile.id).toBeLessThanOrEqual(2)
    }
  })
})

describe("employee numbers", () => {
  it("issues the numbers the reference's index arithmetic produced", () => {
    // 10415 + arrayIndex, for the roster as it stands. Keeping them means
    // moving off the index changes nobody's card today.
    expect(formatEmployeeId(profileFor("frontend-engineer"))).toBe("ID: 10415")
    expect(formatEmployeeId(profileFor("research-analyst"))).toBe("ID: 10418")
    expect(formatEmployeeId(profileFor("security-specialist"))).toBe("ID: 10419")
  })

  it("gives every employee a different number", () => {
    const numbers = EMPLOYEES.map(employeeNumber)
    expect(new Set(numbers).size).toBe(EMPLOYEES.length)
  })

  it("does not change when the roster is reordered", () => {
    // This is the whole reason for diverging from the reference: an ID keyed
    // off an array index is reissued the moment anyone is inserted above.
    const before = new Map(EMPLOYEES.map((profile) => [profile.id, employeeNumber(profile)]))
    const reversed = [...EMPLOYEES].reverse()
    for (const profile of reversed) {
      expect(employeeNumber(profile), profile.id).toBe(before.get(profile.id))
    }
  })

  it("issues a stable number to an id that is not pinned", () => {
    const stranger = { ...profileFor("frontend-engineer"), id: "jordan-okonkwo" }
    expect(employeeNumber(stranger)).toBe(employeeNumber({ ...stranger }))
  })

  it("keeps unpinned numbers out of the pinned block, so nobody is issued twice", () => {
    const pinned = new Set(EMPLOYEES.map(employeeNumber))
    for (const id of ["jordan-okonkwo", "a", "", "zzzz-zzzz", "priya-raman"]) {
      const number = employeeNumber({ ...profileFor("frontend-engineer"), id })
      expect(number, id).toBeGreaterThanOrEqual(10500)
      expect(pinned.has(number), id).toBe(false)
    }
  })
})

describe("departments", () => {
  it("puts every one of the eight somewhere", () => {
    const byId = Object.fromEntries(EMPLOYEES.map((profile) => [profile.id, inferDepartment(profile)]))
    expect(byId).toEqual({
      "frontend-engineer": "Engineering",
      "backend-engineer": "Engineering",
      "platform-engineer": "Engineering",
      "research-analyst": "Data",
      "security-specialist": "Security",
      "product-designer": "Product & Design",
      "quality-engineer": "Engineering",
      "hardware-specialist": "Hardware Engineering",
    })
  })

  it("falls back to Engineering rather than inventing a department", () => {
    expect(inferDepartment({ ...profileFor("frontend-engineer"), title: "Wrangler" })).toBe("Engineering")
  })
})

describe("access levels", () => {
  it("grades every one of the eight", () => {
    const byId = Object.fromEntries(EMPLOYEES.map((profile) => [profile.id, getAccessLevel(profile)]))
    expect(byId).toEqual({
      "frontend-engineer": "Level 2 Access",
      "backend-engineer": "Level 4 Access",
      "platform-engineer": "Level 2 Access",
      "research-analyst": "Level 4 Access",
      "security-specialist": "Level 2 Access",
      "product-designer": "Level 2 Access",
      "quality-engineer": "Level 2 Access",
      "hardware-specialist": "Level 3 Access",
    })
  })

  it("lifts a long-tenured principal a level, and never past five", () => {
    const base = { ...profileFor("hardware-specialist"), title: "Principal Hardware Engineer" }
    expect(getAccessLevel({ ...base, yearsOfExperience: 14 })).toBe("Level 4 Access")
    expect(getAccessLevel({ ...base, yearsOfExperience: 20 })).toBe("Level 5 Access")
    expect(getAccessLevel({ ...base, yearsOfExperience: 40 })).toBe("Level 5 Access")
  })

  it("gives an untitled contributor the floor", () => {
    expect(getAccessLevel({ ...profileFor("frontend-engineer"), title: "Engineer", yearsOfExperience: 2 })).toBe(
      "Level 2 Access",
    )
  })
})

describe("card content", () => {
  it("renders all four rows for every one of the eight without clipping", () => {
    const available = pillTextWidth()
    for (const profile of EMPLOYEES) {
      for (const field of employeeCardContent(profile).fields) {
        const rendered = trackedTextWidth(field.value, field.fontSize, CARD_LAYOUT.pill.letterSpacing)
        expect(rendered, `${profile.id}/${field.row}`).toBeLessThanOrEqual(available)
        // Reaching the floor means the ellipsis is showing.
        expect(field.fontSize, `${profile.id}/${field.row}`).toBeGreaterThan(CARD_LAYOUT.pill.minFontSize)
      }
    }
  })

  it("sets every name at the full headline size, because none is long enough to shrink", () => {
    for (const profile of EMPLOYEES) {
      const content = employeeCardContent(profile)
      expect(content.nameFontSize, profile.id).toBe(CARD_LAYOUT.name.fontSize)
      for (const line of content.nameLines) {
        const rendered = trackedTextWidth(line, content.nameFontSize, CARD_LAYOUT.name.letterSpacing)
        expect(rendered, `${profile.id}/${line}`).toBeLessThanOrEqual(CARD_LAYOUT.name.width)
      }
    }
  })

  it("shrinks a name that would overflow rather than letting it run off the card", () => {
    const long = { ...profileFor("frontend-engineer"), fullName: "Anna Konstantinopoulos" }
    const content = employeeCardContent(long)
    expect(content.nameFontSize).toBeLessThan(CARD_LAYOUT.name.fontSize)
    for (const line of content.nameLines) {
      expect(
        trackedTextWidth(line, content.nameFontSize, CARD_LAYOUT.name.letterSpacing),
      ).toBeLessThanOrEqual(CARD_LAYOUT.name.width)
    }
  })

  it("stops shrinking at the floor and lets the stylesheet clip", () => {
    // There is no font size at which an arbitrarily long single token fits.
    // Past the floor the card keeps its typography and `.nj-name` clips,
    // which is the lesser of two bad outcomes.
    const absurd = { ...profileFor("frontend-engineer"), fullName: "Wolfeschlegelsteinhausenbergerdorff" }
    expect(employeeCardContent(absurd).nameFontSize).toBe(CARD_LAYOUT.name.minFontSize)
  })

  it("labels each row with the caption the template already prints", () => {
    const content = employeeCardContent(profileFor("product-designer"))
    expect(content.fields.map((field) => [field.label, field.value])).toEqual([
      ["Role", "Product Designer"],
      ["Department", "Product & Design"],
      ["Employee ID", "ID: 10420"],
      ["Access level", "Level 2 Access"],
    ])
  })
})

describe("photo backdrop", () => {
  it("builds a gradient across the sampled top edge", () => {
    const pixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]
    expect(photoBackdropGradient(pixels, 3)).toBe(
      "linear-gradient(90deg, rgb(255,0,0) 0%,rgb(0,255,0) 50%,rgb(0,0,255) 100%)",
    )
  })

  it("falls back to the card's own navy when there is nothing to sample", () => {
    expect(photoBackdropGradient([], 5)).toBe(PHOTO_BACKDROP_FALLBACK)
    expect(photoBackdropGradient([1, 2, 3, 4], 1)).toBe(PHOTO_BACKDROP_FALLBACK)
  })
})

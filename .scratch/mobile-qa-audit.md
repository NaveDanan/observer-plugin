# Mobile responsive QA audit

**Auditor:** Daniel Brooks (independent no-code QA)
**Boundary:** read-only audit; no product code, tests, or configuration changed.
**Date:** 2026-08-29

## Scope and limitations

Reviewed the current git diff, `.scratch/mobile-responsive-design.md`,
`.scratch/arjun-mobile-scope.md`, and the changed web surfaces under
`apps/web/src`. Browser automation is unavailable, so widths 280/320/360/375/
390/412, landscape, keyboard, zoom, forced-colors, and touch behavior could
not be exercised; findings below are static-risk findings and test gaps.

## Findings sent to Arjun

1. **High — mobile session rows are not fully keyboard/target accessible.**
   `.session-item` is a clickable `div`; its delete and agent-disclosure
   controls remain roughly 28–30px, and `.agent-mini` is 30px. This misses the
   requested 44px mobile target baseline and leaves the row without semantic
   keyboard activation. Use a semantic button or explicit keyboard semantics,
   enlarge controls/rows, and retain 8px separation.
2. **Medium — detail tabs are below the target baseline.** `.tab` has small
   text and 8px vertical padding with no mobile `min-height:44px`; at 360px
   this also risks an awkward partially visible active tab. Add target sizing
   and verify active-tab reveal.
3. **Medium — landscape sheet sizing is unverified.** The mobile panel has a
   `min-height:56dvh` and `height:min(90dvh,720px)` but no landscape rule;
   short landscape viewports can leave little graph context or obscure HUD
   controls. Add/verify a landscape composition.
4. **Medium — fixed shell can trap enlarged/keyboard content.** `body` uses
   `100dvh` and `overflow:hidden`; at 200% zoom or with the virtual keyboard,
   the fixed app shell may clip content or keep focused controls under the
   keyboard. Verify focus scrolling and an intentional shell scroll strategy.
5. **Medium — ARIA relationships are incomplete.** Detail tabs have
   `role=tab`/`aria-selected` but no `aria-controls` and no linked tabpanel;
   the goal disclosure has no controlled-region ID. Add relationships if the
   corresponding disclosure semantics are retained.
6. **Low — safe-area side insets appear reversed.** Mobile rail/settings
   padding expressions use the right inset for left padding and left for right;
   swap them before testing notched landscape devices.

## Coverage and release verdict

Reduced-motion CSS suppresses infinite/pulsing effects and desktop layout rules
remain present at widths above 900px by static inspection. The added responsive
test is only three source contracts; it does not cover the acceptance matrix,
desktop preservation at 901px, long tokens/transcript overflow, 200% text zoom,
safe areas, virtual keyboard/forms, forced colors, focus return/trap, or target
 sizes. **Verdict: conditional / not release-qualified without browser checks and
 the high/medium findings above being resolved or explicitly accepted.**

## Final static recheck

Arjun's resolution was received and acknowledged. Rechecking the changed files
shows that session rows now have explicit button semantics and Enter/Space
handling; mini rows, disclosure, delete, and detail-tab controls receive 44px
mobile sizing. Detail tabs now expose matching `aria-controls` and
`role="tabpanel"`/`aria-labelledby`, and the goal disclosure has a stable
controlled-region ID. A narrow landscape rule removes the tall sheet minimum
and caps the sheet at 560px. Safe-area padding ordering is correct in the
rechecked rail, settings navigation, topbar, and settings header. Reduced-motion
suppression remains explicit for infinite activity effects.

The fixed shell still uses `body { overflow: hidden }` with a dynamic viewport,
and no executable browser coverage exists for keyboard occlusion, 200% zoom,
forced colors, or the six portrait widths. Long-token containment is present
but unexercised. **Final verdict: conditional pass for the inspected static
changes; not a browser release sign-off.** Original accessibility, ARIA,
landscape, and safe-area findings are addressed statically. Release still
requires browser validation at 280/320/360/375/390/412 portrait and landscape,
desktop 901px+, virtual keyboard/focus scrolling, 200% zoom, overflow, and
forced colors; fixed-shell/keyboard risk remains open until then.

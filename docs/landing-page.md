# Afterhours landing page

The current direction follows the user's Roman Empire brief and the repository's
`.agents/skills/frontend-design/SKILL.md`. It supersedes the earlier animated
Figma hero. Design planning and the review against the brief are recorded in
`docs/roman-design-plan.md`.

## Visual identity

- Original assembly artwork: `apps/web/public/assets/afterhours-assembly.png`,
  copied unchanged from the user-provided `afterbannerimage.png` (1344 × 576).
- The full banner is visible on desktop. A centered mobile crop keeps Afterhour
  and the surrounding assembly in view without shrinking them into a thumbnail.
- Locally hosted Marcellus for classical headings and the wordmark, with Geist
  for body text, forms and data. `scripts/build-web.mjs` copies these fonts.
- Limestone and marble reading surfaces, olive ink, deep olive forum section,
  and restrained bronze details taken from the artwork's palette.
- Static layout: no GSAP import, dependency, glass rectangles, motion controls,
  animated entrances, or automatic background movement.
- The market monitor uses the same palette and typography.

## Content and access

The page explains why collective governance needs delegated execution. The
open forum allows everyone to converse without a wallet or token balance.
Anonymous browser sessions isolate histories. The read-only boundary and truthful
connection status remain; chat grants no transaction or governance authority.

## Local review

Check desktop, tablet, and narrow mobile widths, plus the open composer and
keyboard focus. Confirm the banner and fonts load, there is no horizontal
overflow, and chat copy and controls remain legible. Live Hermes replies still
require the dedicated holder API configuration described in `apps/web/README.md`.

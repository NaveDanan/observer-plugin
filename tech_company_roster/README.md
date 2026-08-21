# NJ-LABS Employee Card Generator

Simple static webapp that fills `emploee-card.png` (1023×1537) with data from `company_roster.json:1` and the profile portrait from `images/*`.

Portrait is **never warped**. The source images are square (1254×1254) but the frame is portrait (418×574), so a plain `cover` fit would crop ~27% off each side and cut off the artwork around the subject. Instead the portrait is drawn at 80% of `cover` (`PHOTO_ZOOM` in `app.js`) and pinned to the frame bottom, so the subject sits on the frame edge instead of floating. The gap that leaves above it is filled with the portrait's own top-edge colour — a sampled gradient in the preview (`paintPhotoBackdrop`), stretched edge pixels in the export — so the backdrop continues seamlessly.

Changing the zoom means editing two places that must agree: `PHOTO_ZOOM` in `app.js` and the `width`/`height` percentages on `.photo-img` in `style.css`.

## Run

```bash
cd /home/naved/Documents/pythonprojects/tech_company_roster
python3 -m http.server 5173
# open http://localhost:5173
```

No build step. Any static server works (`npx serve`, `python -m http.server`, VS Code Live Server, etc.).
Opening via `file://` will fail to `fetch` the JSON — use a server.

## How it works

- `index.html:1` — layout (select + live card preview)
- `style.css` — `.photo-frame` (10.95% left, 31.62% top, 40.86%×37.34%) with the bottom-pinned `.photo-img`; pill positions derived from pixel-measured rects `112,486,530,1060` (photo) and `652,678,918,720` etc. (pills)
- `app.js:11` — `inferDepartment()`, `formatEmployeeId()`, `getAccessLevel()`; `applyProfile()` updates DOM; `exportPNG()` renders a 1023×1537 `<canvas>` (`index.html:46`) and triggers a download (`NJ-LABS-card-<id>.png`)

### Field mapping — name now above ROLE (DATAVISTA style, `style.css:103`)

| Card slot | Source |
|---|---|
| Photo | `profiles[].image.relative_url` (e.g. `images/01_arjun_mehta_frontend_engineer.png:42`) |
| **Name (large, above line)** | `full_name` stripped of `Dr.` → split into 2 lines (`app.js:43`) e.g. `Maya` / `Chen` at `590,505` / `52px` |
| ROLE | `shortRoleTitle(role.title)` → `VP Data & Analytics` (`app.js:22`) |
| DEPARTMENT | inferred → `Data` (short) (`app.js:16`) |
| EMPLOYEE ID | `ID: 10427` (10415+index) (`app.js:48`) — matches DATAVISTA `ID: 10427` |
| ACCESS LEVEL | `Level 5 Access` (`app.js:51`) — matches reference |

## Export

“Download PNG” draws the template + portrait (zoomed to `PHOTO_ZOOM` of cover, bottom-pinned, clipped to a 14 px rounded rect) + pill texts (centered, auto-shrinks if >20 chars) + name/badge. Output is `1023×1537` PNG, ready to print.

## Structure

```
.
├── emploee-card.png          # 1023×1537 template (note typo is intentional)
├── company_roster.json       # 14 profiles, images in images/
├── images/                   # 1254×1254 portraits
├── index.html
├── style.css
└── app.js
```

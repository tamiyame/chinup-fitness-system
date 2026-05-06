# CHINUP Performance · Web UI Kit

Hi-fi recreation of the CHINUP Performance course-registration web app (`tamiyame/chinup-fitness-system`).

## Files
- `index.html` — interactive demo (login → courses → my registrations → admin)
- `Nav.jsx` — top navigation bar with auth chip
- `Hero.jsx` — page hero (eyebrow + h1 + subtitle)
- `CourseAccordion.jsx` — accordion-grouped course list (the home page primary surface)
- `SessionCard.jsx` — individual course session card with capacity bar + CTA
- `RegistrationRow.jsx` — "my registrations" row with date block + status badges
- `LoginCard.jsx` — login / register card
- `AdminStats.jsx` — admin dashboard stat tiles
- `Toast.jsx` — bottom-right toast notification

All components mirror the production CSS classes (`btn-primary`, `card`, `badge-*`, `day-group`, etc.) so they slot into the real product without rework.

# PROJ-101: Add slugify util

Add `slugify(str)` in `src/utils/slugify.js` (CommonJS export).

Acceptance criteria:
- Lowercases the input.
- Any run of non-alphanumeric characters becomes a single `-`.
- No leading or trailing `-`.
- `slugify("")` returns `""`.

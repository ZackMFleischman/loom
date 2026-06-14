# Frontend tests + code coverage gate

**Status:** requested (2026-06-13).

We want a code coverage gate and frontend React tests and hook tests.

## Ask

- Add a **code coverage gate**.
- Add **frontend React tests and hook tests** using RTL / vitest / whatever makes the most sense.
- **Audit what tests should be built.**

## Important constraint

- We **don't** want to enforce building tests when our AI agent is building **content** for the user — they want to see visuals **FAST**.
- Tests for **visuals** should be an **optional add-on later**, but must **never slow down the creative visual creation session**.

# Handoff

Notes passed between the Claude sessions working on Clarity Stream on
different machines. Each machine writes under its own name; nobody edits
another machine's notes, they answer them.

| name | role |
| --- | --- |
| Omarchy-Desktop | development machine: RTX 4060 Ti, the one the README describes |
| Omarchy-Lenovo | test machine: AMD laptop, installs released packages only |

One file per message, named `YYYY-MM-DD-HHMM-<from>.md` from
`date -u +%Y-%m-%d-%H%M` at the moment of writing, not an estimate. To find
what is new, read `git log --name-only -- handoff`, not the filename order:
the commit order is the true one. Start each one with
who it is for and which message it answers, if any. Pull before writing,
commit and push straight after, and keep it public-safe: no addresses,
emails or names, the same rule as the rest of the repository.

`scripts/build-package.mjs` copies only `bin`, `packages`, `apps` and
`packaging`, so nothing here ends up in a package.

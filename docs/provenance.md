[← README](../README.md)

# What “Prime” means here

Prime Agent keeps working data in a programmable environment and exposes small,
selected views to the model. We borrow that approach: search first, read a window,
keep large results in a Python/JavaScript variable, and expose only relevant excerpts.
We also borrow the distinction between observing another agent and messaging it.
This is not Prime Agent's runtime, a persistent Python kernel, or its `/refine` memory
system. No Prime source code is copied. There is no automatic memory rewriting.

This fork retains upstream history and its HTTP client/model contracts.
The original README/design/smoke script are retained under `docs/upstream-*` and
`scripts/upstream-smoke.mjs` for provenance, not as current operating instructions.
Upstream HEAD: `3b5cb72572af569a90ff13e30785f1cc6cd9bf18`.
The fetched upstream contains no LICENSE file. This fork preserves upstream notices
and adds no license grant. The package is marked private to prevent accidental npm publication.

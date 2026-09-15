# Iskra integration — design only

Goal: ask Iskra for an independent opinion on a precise work snapshot and return that opinion to its originating T3 task. No Iskra transport, credentials, remote writes, or runtime changes are installed by this release.

## Proposed seam

Use a version-bound review packet behind a separate adapter. The existing Iskra repository describes a Forgejo `needs-iskra-review` watcher: a labeled request produces one review comment and a deduplication label. Its current deployment and cross-repository support still need verification. Neither an M1 machine nor an Iskra runtime destination has been verified as a T3 recipient.

The first adapter should reuse that workflow if the read-only audit confirms it is live. Do not assume a local file path is accessible to another machine. Publishing a packet or comment needs authorization for the concrete destination; the local MCP mailbox does not grant it.

## Packet and response

Proposed packet fields: `packetId`, `repo`, `baseSha`, `headSha`, `diffSha256`, `artifactPath`, `purpose`, `questions`, `acceptance`, `replyTo`, `createdAt`. For dirty work, the artifact must contain the precise intended diff and relevant new files; the packet hash binds all fields.

Proposed response fields: `packetId`, `headSha`, `packetSha256`, `verdict`, `findings`, `evidence`. Verdicts: `approve`, `changes_requested`, `stale`, `blocked`.

Only matching packet/revision/hash identities can attach an opinion to the task. If the work has advanced, report stale feedback instead of silently applying it. Replies remain advice; the adapter neither edits, merges nor deploys.

## Smallest acceptance test for the future adapter

Use a test PR and one packet. Verify that the watcher emits one correlated reply, that a repeated delivery does not create a second review, and that changing the revision produces `stale`. Then return the accepted opinion through the existing local feedback/disposition flow. First validate the packet/parser locally; enable the remote route only after the destination and transport are confirmed.

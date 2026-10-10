# Browser tests

These run against a real browser because the thing under test does not exist in
jsdom. `chatstore` is IndexedDB: `fake-indexeddb` would test the fake, and this
session already shipped a bug where the fixed code lived in a file the app did
not import — a test passing against the wrong thing is worse than no test.

    npx esbuild src/lib/chatstore.ts --bundle --format=esm --outfile=/tmp/cs/chatstore.mjs
    cp test/browser/chatstore.html /tmp/cs/t.html
    node test/browser/run-chatstore.mjs /tmp/cs

Every line of output must read PASS.

## chat-persistence.mjs

Proves the thing the unit tests cannot: that the APP uses the store. It runs a
recording relay (`recording-relay.mjs`) which logs every filter it is asked
for, opens chat twice in one browser, and checks that the second visit asks for
`since = <cursor>` rather than the week.

    node test/browser/recording-relay.mjs 7471 /tmp/relay-filters.json &
    node test/browser/chat-persistence.mjs

Expected:

    first visit : 40 bubbles rendered, 40 notes in IndexedDB
                  room REQ since=<week>
    second visit: 40 bubbles rendered, 40 notes in IndexedDB
                  room REQ since=<cursor> -> DELTA (cursor used)

Two traps this harness has already fallen into, both worth keeping in mind when
editing it: the relay rewrites its ENTIRE in-memory filter history on every
write, so truncating the log file proves nothing — read the LAST matching
request. And the first `kinds:[1]` request is the unread peek, not the room, so
match on the subscription id.

# Browser tests

These run against a real browser because the thing under test does not exist in
jsdom. `chatstore` is IndexedDB: `fake-indexeddb` would test the fake, and this
session already shipped a bug where the fixed code lived in a file the app did
not import — a test passing against the wrong thing is worse than no test.

    npx esbuild src/lib/chatstore.ts --bundle --format=esm --outfile=/tmp/cs/chatstore.mjs
    cp test/browser/chatstore.html /tmp/cs/t.html
    node test/browser/run-chatstore.mjs /tmp/cs

Every line of output must read PASS.

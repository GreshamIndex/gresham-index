Gresham Index — daily publisher

Computes the Gresham Index (Bitcoin cycle risk, frozen methodology v1.0.1)
once a day and publishes the results as JSON via GitHub Pages.

Public files (served from docs/):


latest.json — today's reading: value, zone, action, price, timestamps
history.json — full daily series since 2011 (reconstruction + live, labeled)
record.json — the as-published, append-only track record (immutable; every entry has a git commit timestamp)
selftest.json — daily recomputation of the 19 frozen acceptance vectors


Integrity: the engine (gresham_engine.js) is an exact port of the published
specification; selftest.json proves it against the frozen test vectors every
single day, from live data. The git history of this repository is the
tamper-evident timestamp of every published reading.

Data: CoinMetrics Community API — CC BY-NC 4.0, attribution required.
This is an informational and educational tool, not investment advice.

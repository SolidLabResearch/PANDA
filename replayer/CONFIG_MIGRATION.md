# Config Migration: `locations + file_location` -> `streams`

## What changed

The replayer now requires a per-stream config model:

- Removed: top-level `locations` array
- Removed: top-level `file_location`
- Added: top-level `streams` array with objects containing:
  - `location`
  - `file_location`

The old shape is intentionally rejected with a clear startup error.

## Before

```json
{
  "locations": [
    "http://localhost:3000/alice/acc-x/",
    "http://localhost:3000/alice/acc-y/"
  ],
  "frequency_event": 4,
  "frequency_buffer": 4,
  "file_location": "/path/to/all-observations.nt",
  "is_ldes": false,
  "tree_path": "https://saref.etsi.org/core/hasTimestamp"
}
```

## After

```json
{
  "streams": [
    {
      "location": "http://localhost:3000/alice/acc-x/",
      "file_location": "/path/to/acc-x.nt"
    },
    {
      "location": "http://localhost:3000/alice/acc-y/",
      "file_location": "/path/to/acc-y.nt"
    }
  ],
  "frequency_event": 4,
  "frequency_buffer": 4,
  "is_ldes": false,
  "tree_path": "https://saref.etsi.org/core/hasTimestamp"
}
```

## Validation notes

- `streams` must be non-empty.
- Each stream requires non-empty `location` and `file_location`.
- Each `file_location` must exist at startup.

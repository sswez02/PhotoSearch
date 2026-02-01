# PhotoSearch | Cloud-native photo ingestion + processing pipeline (GCS + Pub/Sub + Cloud Run + Cloud SQL)

PhotoSearch is a production-style backend inspired by Google Photos ingestion workflow: clients upload image bytes directly to cloud storage via signed URLs, then an asynchronous worker extracts metadata (EXIF), generates thumbnails, and persists results for querying

**Core goals**

- Keep the API fast and lightweight
- Use an async pipeline for CPU/IO work
- Demonstrate cloud-native deployment

## Data model + lifecycle

A photos row progresses through a simple state machine:

- PENDING: row created, object path reserved
- UPLOADED: client confirmed upload complete
- PROCESSED: worker extracted metadata and wrote thumbnail
- ERROR: permanent failure (bad payload, missing object, etc.)

## Measured results

**API latency (Cloud Run, k6, 20 VUs, 30s):**

- `POST /photos` p95: 55.6ms
- `GET /photos?q=` p95: 62.5ms
- Request failure rate: 0.00%
- Throughput: ~203 req/s (overall)

**Async processing latency (Cloud Run worker + Pub/Sub + Cloud SQL, n=50):**
Time from `uploaded_at` → `processed_at`:

- min: 175ms, avg: 337.1ms
- p50: 279.5ms, p95: 849.3ms, max: 1367ms

# APIs

**Create placeholder row**

`POST /photos`

```
{ "originalFilename": "img.jpg", "contentType": "image/jpeg" }
```

**Get signed upload URL**

`POST /photos/:id/upload-url`

```
{ "contentType": "image/jpeg" }
```

**Mark upload complete + enqueue processing**

`POST /photos/:id/complete`

```
{ "sizeBytes": 12345, "contentType": "image/jpeg" }
```

**Get photo metadata**

`GET /photos/:id`

**Get signed thumbnail URL (only after processed)**

`GET /photos/:id/thumbnail-url`

**Search/list**

`GET /photos?q=test&from=2026-02-01&to=2026-02-02&limit=20&offset=0`

- `q`: filename fuzzy match (uses `pg_trgm` if enabled; substring fallback)

- `from` / `to`: filter on `taken_at` (EXIF-derived; may be null if missing)

# Demo

```js
$BASE="YOUR_API_URL"
$FILE="C:\path\to\test.jpg"

# 1) Create
$create = Invoke-RestMethod -Method POST "$BASE/photos" `
  -ContentType "application/json" `
  -Body (@{ originalFilename="test.jpg"; contentType="image/jpeg" } | ConvertTo-Json)
$ID = $create.id
"created id=$ID"

# 2) Upload URL
$upload = Invoke-RestMethod -Method POST "$BASE/photos/$ID/upload-url" `
  -ContentType "application/json" `
  -Body (@{ contentType="image/jpeg" } | ConvertTo-Json)
$uploadUrl = $upload.uploadUrl

# 3) PUT bytes
curl.exe -X PUT "$uploadUrl" -H "Content-Type: image/jpeg" --data-binary "@$FILE" | Out-Null

# 4) Complete (publish Pub/Sub)
Invoke-RestMethod -Method POST "$BASE/photos/$ID/complete" `
  -ContentType "application/json" `
  -Body (@{ sizeBytes=(Get-Item $FILE).Length; contentType="image/jpeg" } | ConvertTo-Json) | Out-Null

# 5) Poll until processed, then open thumbnail
for ($i=0; $i -lt 20; $i++) {
  try {
    $thumb = Invoke-RestMethod "$BASE/photos/$ID/thumbnail-url"
    $thumb.url
    Start-Process $thumb.url
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
```

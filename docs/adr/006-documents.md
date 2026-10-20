# ADR-006: Document storage, scanning and access

## Context

Signed contracts, government IDs, permits and import workbooks must be stored privately,
scanned for malware, stripped of metadata, and served only through short-lived signed URLs
after an authorization check, with every access logged (brief §8.1).

## Decision

1. **Initiate.** `POST /documents` validates the declared type against an allowlist (PDF,
   JPEG, PNG, XLSX), the extension, the size limit and the company scope. It creates a
   `PENDING_UPLOAD` row and returns a **5-minute presigned PUT** to `quarantine/<id>`.
   Content-Type and Content-Length are signed. Files never pass through the API.
2. **Complete.** `POST /documents/:id/complete` checks that the object exists with the
   declared size, sets `QUARANTINED` and enqueues a scan job (job id = document id, so it is
   idempotent).
3. **Scan (worker).** The worker:
   - checks the magic bytes match the declared type;
   - scans with ClamAV over INSTREAM. Errors and timeouts are retried, never treated as
     clean;
   - re-encodes images to strip EXIF, GPS and XMP;
   - computes SHA-256;
   - writes to `clean/<id>` with SSE-KMS and deletes the quarantine copy.
     The result is `CLEAN`, `INFECTED` (with an alert) or `REJECTED`. Quarantine objects
     expire after a day.
4. **Download.** `POST /documents/:id/download-url` checks scope again. `SENSITIVE`
   documents (government IDs, financial statements are forced to this class) need
   `document.read_sensitive`. It returns a **5-minute presigned GET** with
   `Content-Disposition: attachment` and audits `document.download_url`.

## Consequences

- **Browser uploads cross to the bucket origin.** The web CSP `connect-src` includes
  `UPLOAD_ORIGIN`, and the bucket CORS allows only the web origin.
- **PDF metadata is not rewritten yet.** PDFs are scanned but their metadata is kept.
  Revisit if signed PDFs are not required to stay byte-identical.

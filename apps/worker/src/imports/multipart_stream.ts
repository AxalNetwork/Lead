// Task #3: streaming multipart parser used by /api/uploads/csv to pipe
// the file part directly to R2 without ever buffering the full body.
//
// Spec constraint: "Stream, never buffer." Workers' built-in
// req.formData() materializes every part in memory; for 50 MB CSV
// uploads that's a hard memory-pressure failure. This module exposes
// streamFileFieldToR2(): it scans the request body for the multipart
// boundary, extracts the headers of the named field's part, then pipes
// the field's bytes to R2.put as a ReadableStream — emitting each
// chunk as it arrives.
//
// Algorithm: incremental boundary scan with a rolling tail buffer.
// On each inbound chunk we concatenate it onto `pending`, search for
// the next boundary occurrence, emit everything before it (minus a
// safety tail equal to boundary.length+4 so a boundary straddling the
// next chunk boundary isn't missed), and stash the rest. When the
// terminating boundary is found we close the emit stream.

export interface StreamedFileField {
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
  done: Promise<{ size: number; otherFields: Record<string, string> }>;
}

export function streamFileFieldToR2(req: Request, fieldName: string): StreamedFileField {
  const ct = req.headers.get("content-type") ?? "";
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) throw new Error("multipart_no_boundary");
  const boundary = (m[1] ?? m[2]).trim();
  const enc = new TextEncoder();
  const boundaryMarker = enc.encode(`--${boundary}`);
  const crlfBoundary = enc.encode(`\r\n--${boundary}`);
  if (!req.body) throw new Error("multipart_no_body");
  const reader = req.body.getReader();

  const otherFields: Record<string, string> = {};
  let filename = "";
  let fileContentType = "application/octet-stream";
  let totalEmitted = 0;
  let resolveDone: (v: { size: number; otherFields: Record<string, string> }) => void;
  let rejectDone: (e: unknown) => void;
  const donePromise = new Promise<{ size: number; otherFields: Record<string, string> }>((res, rej) => {
    resolveDone = res; rejectDone = rej;
  });

  const fileStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let pending: Uint8Array = new Uint8Array(0) as unknown as Uint8Array;
        let mode: "preamble" | "headers" | "scanning_field" | "scanning_file" | "done" = "preamble" as "preamble" | "headers" | "scanning_field" | "scanning_file" | "done";
        let currentFieldName = "";
        let currentFilename = "";
        let currentContentType = "";

        const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
          const out = new Uint8Array(a.length + b.length);
          out.set(a, 0);
          out.set(b, a.length);
          return out;
        };

        const indexOf = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
          outer: for (let i = from; i <= haystack.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) {
              if (haystack[i + j] !== needle[j]) continue outer;
            }
            return i;
          }
          return -1;
        };

        const readMore = async (): Promise<boolean> => {
          const { done, value } = await reader.read();
          if (done || !value) return false;
          // Normalize to a plain ArrayBuffer-backed Uint8Array so the
          // generic Uint8Array<ArrayBuffer> required by ReadableStream
          // is satisfied (some runtimes hand us Uint8Array<ArrayBufferLike>).
          const v = new Uint8Array(value.byteLength);
          v.set(value as Uint8Array);
          pending = concat(pending, v) as Uint8Array;
          return true;
        };

        while (mode !== "done") {
          if (mode === "preamble") {
            const idx = indexOf(pending, boundaryMarker);
            if (idx < 0) {
              if (!await readMore()) throw new Error("multipart_truncated_preamble");
              continue;
            }
            // Skip past `--boundary` and the trailing CRLF (or `--` for the
            // terminating boundary).
            const after = idx + boundaryMarker.length;
            if (pending.length < after + 2) { if (!await readMore()) throw new Error("multipart_truncated_preamble"); continue; }
            if (pending[after] === 0x2d && pending[after + 1] === 0x2d) { // `--` end of stream
              mode = "done"; break;
            }
            // Expect CRLF.
            if (pending[after] !== 0x0d || pending[after + 1] !== 0x0a) {
              throw new Error("multipart_bad_boundary");
            }
            pending = pending.slice(after + 2);
            mode = "headers";
          } else if (mode === "headers") {
            // Read until \r\n\r\n.
            const sep = enc.encode("\r\n\r\n");
            const idx = indexOf(pending, sep);
            if (idx < 0) {
              if (!await readMore()) throw new Error("multipart_truncated_headers");
              continue;
            }
            const headerBlock = new TextDecoder().decode(pending.slice(0, idx));
            pending = pending.slice(idx + sep.length);
            currentFieldName = ""; currentFilename = ""; currentContentType = "application/octet-stream";
            for (const line of headerBlock.split(/\r\n/)) {
              const lc = line.toLowerCase();
              if (lc.startsWith("content-disposition:")) {
                const nameM = /name="([^"]*)"/i.exec(line);
                const fnM = /filename="([^"]*)"/i.exec(line);
                if (nameM) currentFieldName = nameM[1];
                if (fnM) currentFilename = fnM[1];
              } else if (lc.startsWith("content-type:")) {
                currentContentType = line.slice(line.indexOf(":") + 1).trim();
              }
            }
            if (currentFieldName === fieldName && currentFilename) {
              filename = currentFilename;
              fileContentType = currentContentType;
              mode = "scanning_file";
            } else {
              mode = "scanning_field";
            }
          } else if (mode === "scanning_field" || mode === "scanning_file") {
            // Scan for the next boundary (preceded by CRLF). Emit safe
            // bytes (everything except the last crlfBoundary.length-1
            // bytes, which might be the start of a boundary).
            const idx = indexOf(pending, crlfBoundary);
            if (idx < 0) {
              const safe = Math.max(0, pending.length - (crlfBoundary.length - 1));
              if (mode === "scanning_file" && safe > 0) {
                const chunk = pending.slice(0, safe);
                controller.enqueue(chunk);
                totalEmitted += chunk.length;
              } else if (mode === "scanning_field" && safe > 0) {
                // accumulate small-field text (rare; for completeness)
                otherFields[currentFieldName] = (otherFields[currentFieldName] ?? "") + new TextDecoder().decode(pending.slice(0, safe));
              }
              pending = pending.slice(safe);
              if (!await readMore()) throw new Error("multipart_truncated_part");
              continue;
            }
            // Emit/store everything before the boundary.
            if (mode === "scanning_file") {
              const chunk = pending.slice(0, idx);
              if (chunk.length) { controller.enqueue(chunk); totalEmitted += chunk.length; }
            } else {
              const text = new TextDecoder().decode(pending.slice(0, idx));
              otherFields[currentFieldName] = (otherFields[currentFieldName] ?? "") + text;
            }
            // Advance past the CRLF + boundary marker. The byte AFTER the
            // boundary marker is either CRLF (more parts) or `--` (end).
            const after = idx + crlfBoundary.length;
            // Need 2 more bytes to peek at terminator.
            while (pending.length < after + 2) {
              if (!await readMore()) throw new Error("multipart_truncated_boundary");
            }
            if (pending[after] === 0x2d && pending[after + 1] === 0x2d) {
              mode = "done";
              break;
            }
            if (pending[after] !== 0x0d || pending[after + 1] !== 0x0a) {
              throw new Error("multipart_bad_boundary_suffix");
            }
            pending = pending.slice(after + 2);
            mode = "headers";
          }
        }
        controller.close();
        resolveDone({ size: totalEmitted, otherFields });
      } catch (e) {
        try { controller.error(e); } catch { /* swallow */ }
        rejectDone(e);
      } finally {
        try { reader.releaseLock(); } catch { /* swallow */ }
      }
    },
  });

  return {
    get filename() { return filename; },
    get contentType() { return fileContentType; },
    stream: fileStream,
    done: donePromise,
  } as StreamedFileField;
}

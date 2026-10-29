"""Convert kb_index.json (notebook export) into compact binary assets for the Worker.

Usage: python3 scripts/build_kb.py [path/to/kb_index.json]
Outputs in public/kb/:
  vectors.f32  - L2-normalised float32 embeddings, row-major (count x dim)
  texts.bin    - all chunk texts, UTF-8, concatenated
  meta.json    - {dim, count, chunks:[{t,d,s,h,o,l}]}  (o/l = byte offset/length in texts.bin)
"""
import json, struct, sys, os
import numpy as np

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "kb_index.json")
out = os.path.join(os.path.dirname(__file__), "..", "public", "kb")
os.makedirs(out, exist_ok=True)

data = json.load(open(src, encoding="utf-8"))
vecs = np.array([c["embedding"] for c in data], dtype="float32")
norms = np.linalg.norm(vecs, axis=1, keepdims=True); norms[norms == 0] = 1
vecs = (vecs / norms).astype("<f4")
vecs.tofile(os.path.join(out, "vectors.f32"))

chunks, blob, off = [], bytearray(), 0
for c in data:
    b = c["text"].encode("utf-8")
    m = c.get("metadata", {})
    chunks.append({
        "t": m.get("source_type", ""), "d": m.get("drug_name", ""),
        "s": m.get("section", ""), "h": m.get("source_doc", ""),
        "o": off, "l": len(b),
    })
    blob += b; off += len(b)
open(os.path.join(out, "texts.bin"), "wb").write(bytes(blob))
json.dump({"dim": int(vecs.shape[1]), "count": len(data), "chunks": chunks},
          open(os.path.join(out, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("chunks", len(data), "dim", vecs.shape[1])

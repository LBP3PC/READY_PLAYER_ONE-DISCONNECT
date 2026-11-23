"""Retire les references .htr (fn29 de chaque objet) des scenes importees."""
import base64
import hashlib
import json
import os
import uuid

FN_REF = 29


def read_varint(d, pos):
    r = 0
    s = 0
    while True:
        b = d[pos]
        pos += 1
        r |= (b & 0x7F) << s
        if not (b & 0x80):
            return r, pos
        s += 7


def write_varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def fields(d):
    """Retourne [(fn, wt, tag_bytes, value_bytes_or_None, raw_start, raw_end)]."""
    out = []
    pos = 0
    while pos < len(d):
        st = pos
        tag, pos = read_varint(d, pos)
        fn = tag >> 3
        wt = tag & 7
        tag_bytes = d[st:pos]
        if wt == 0:
            v, pos2 = read_varint(d, pos)
            out.append((fn, wt, tag_bytes, None, st, pos2))
            pos = pos2
        elif wt == 2:
            ln, p = read_varint(d, pos)
            end = p + ln
            if end > len(d):
                raise ValueError("truncated len field")
            out.append((fn, wt, tag_bytes, d[p:end], st, end))
            pos = end
        elif wt == 1:
            out.append((fn, wt, tag_bytes, None, st, pos + 8))
            pos += 8
        elif wt == 5:
            out.append((fn, wt, tag_bytes, None, st, pos + 4))
            pos += 4
        else:
            raise ValueError("wire type %d" % wt)
    return out


def rebuild(items):
    """items: [(tag_bytes, payload_or_None, raw_bytes_or_None)]."""
    out = bytearray()
    for tag, payload, raw in items:
        if raw is not None:
            out += raw
        else:
            out += tag + write_varint(len(payload)) + payload
    return bytes(out)


def strip_object(payload):
    """Retire les champs fn29 qui referencent un .htr. Retourne (nouveau, nb)."""
    items = []
    removed = 0
    for fn, wt, tag, val, st, en in fields(payload):
        if fn == FN_REF and wt == 2 and val is not None and b".htr" in val:
            removed += 1
            continue
        if wt == 2 and val is not None and len(val) > 1:
            new, n = strip_object(val) if _parses(val) else (val, 0)
            if n:
                items.append((tag, new, None))
                removed += n
                continue
        items.append((tag, None, payload[st:en]))
    return rebuild(items), removed


def _parses(d):
    try:
        fields(d)
        return True
    except Exception:
        return False


def main():
    plan = json.load(open("import-fix/manifest.json"))
    os.makedirs("import-fix/stripped", exist_ok=True)
    out = {}
    for sub, (room, path, _n) in plan.items():
        data = open(path, "rb").read()
        items = []
        total = 0
        for fn, wt, tag, val, st, en in fields(data):
            if fn == 2 and wt == 2 and val is not None:
                new, n = strip_object(val)
                total += n
                if n:
                    items.append((tag, new, None))
                    continue
            items.append((tag, None, data[st:en]))
        newdata = rebuild(items)
        assert b".htr" not in newdata, path
        assert newdata != data
        name = "%s_%s.binpb" % (room, sub)
        dest = os.path.join("import-fix/stripped", name)
        open(dest, "wb").write(newdata)
        out[sub] = {
            "room": room,
            "file": dest,
            "refs_removed": total,
            "old_bytes": len(data),
            "new_bytes": len(newdata),
            "hash": base64.b64encode(hashlib.sha256(newdata).digest()).decode(),
            "key": "2026-11-23/" + str(uuid.uuid4()),
        }
        print("%-4s refs retires=%d  %d -> %d octets" % (sub, total, len(data), len(newdata)))
    json.dump(out, open("import-fix/stripped/manifest.json", "w"), indent=1)
    print("total refs:", sum(v["refs_removed"] for v in out.values()))


main()

import struct
import sys
from collections import Counter

STD = r"C:\RecRoom2023\RecRoom_Data\il2cpp_data\Metadata\global-metadata.dat"
TGT = r".tmp\recroom-20231219-backup\global-metadata.dat"

NAMES = [
    "stringLiteral", "stringLiteralData", "string", "events", "properties", "methods",
    "parameterDefaultValues", "fieldDefaultValues", "fieldAndParameterDefaultValueData",
    "fieldMarshaledSizes", "parameters", "fields", "genericParameters",
    "genericParameterConstraints", "genericContainers", "nestedTypes", "interfaces",
    "vtableMethods", "interfaceOffsets", "typeDefinitions", "images", "assemblies",
    "fieldRefs", "referencedAssemblies", "attributeData", "attributeDataRange",
    "unresolvedIndirectCallParameterTypes", "unresolvedIndirectCallParameterRanges",
    "windowsRuntimeTypeNames", "windowsRuntimeStrings", "exportedTypeDefinitions",
]

std = open(STD, "rb").read()
magic, ver = struct.unpack_from("<Ii", std, 0)
print(f"STD size={len(std)} magic=0x{magic:X} version={ver}")
tables = {}
for i, name in enumerate(NAMES):
    off, size = struct.unpack_from("<ii", std, 8 + i * 8)
    tables[name] = (off, size)
    print(f"{i:2} {name:42} off=0x{off:09X} size=0x{size:09X}")

# Target tiling solution 0.
REGIONS = [
    (0x100, 0x59BA0), (0x59CA0, 0x228C8), (0x7C568, 0x209328), (0x285890, 0x6D658),
    (0x2F2EE8, 0x0), (0x2F2EE8, 0x1B7D04), (0x4AABEC, 0x124A0), (0x4BD08C, 0x3C8F20),
    (0x885FAC, 0x4B6254), (0xD3C200, 0x90E100), (0x164A300, 0x2CA4), (0x164CFA4, 0x301F0),
    (0x167D194, 0x2331C), (0x16A04B0, 0x3AA8), (0x16A3F58, 0xE4DD8), (0x1788D30, 0x16CC8),
    (0x179F9F8, 0x9648), (0x17A9040, 0x1C87B0), (0x19717F0, 0x1B510), (0x198CD00, 0x1FCC),
    (0x198ECCC, 0x57868), (0x19E6534, 0x12714), (0x19F8C48, 0x32F0), (0x19FBF38, 0x23A340),
    (0x1C36278, 0x5180), (0x1C3B3F8, 0x714E4), (0x1CAC8DC, 0x31437C), (0x1FC0C58, 0x118000),
    (0x20D8C58, 0x29EF8), (0x2102B50, 0x0), (0x2102B50, 0x2D88),
]
tgt = open(TGT, "rb").read()
STR_OFF, STR_SIZE = 0x885FAC, 0x4B6254


def valid_str(idx):
    if not (0 <= idx < STR_SIZE):
        return False
    p = STR_OFF + idx
    end = STR_OFF + STR_SIZE
    n = 0
    while p < end and n < 80:
        c = tgt[p]
        if c == 0:
            return n > 0
        if c < 0x20 or c > 0x7E:
            return False
        p += 1
        n += 1
    return False


# For each region and stride, count entries whose token byte (at a given offset) is a given kind
# and whose nameIndex is a valid string.
candidates = {
    "typedef": (88, 84, 0x02, 0),
    "method": (32, 24, 0x06, 0),
    "method36": (36, 28, 0x06, 0),
    "field": (12, 8, 0x04, 0),
    "param": (12, 8, 0x08, 0),
    "property": (20, 16, 0x17, 0),
    "event": (24, 20, 0x14, 0),
    "image": (40, 36, 0x01, 0),
    "assembly": (64, 4, 0x20, 0),
}
print("\n--- target regions ---")
for idx, (off, size) in enumerate(REGIONS):
    if size == 0:
        print(f"[{idx:2}] off=0x{off:09X} size=0")
        continue
    print(f"[{idx:2}] off=0x{off:09X} size=0x{size:09X}", end="")
    for label, (stride, tokoff, kind, nameoff) in candidates.items():
        if size % stride:
            continue
        n = size // stride
        if n > 20000:
            step = max(1, n // 2000)
            indices = range(0, n, step)
        else:
            indices = range(n)
        tok = name = total = 0
        for i in indices:
            b = off + i * stride
            total += 1
            if b + tokoff + 4 <= len(tgt):
                t = struct.unpack_from("<I", tgt, b + tokoff)[0]
                if (t >> 24) == kind:
                    tok += 1
            if b + nameoff + 4 <= len(tgt):
                ni = struct.unpack_from("<I", tgt, b + nameoff)[0]
                if valid_str(ni):
                    name += 1
        if tok or name:
            print(f"  {label}: n={n} tok={tok}/{total} name={name}/{total}", end="")
    print()

# Standard metadata table counts for comparison.
print("\n--- standard 20230414 derived counts ---")
for label, (stride, tokoff, kind, nameoff) in candidates.items():
    for name, (off, size) in tables.items():
        if size and size % stride == 0:
            n = size // stride
            if n < 2:
                continue
            tok = 0
            for i in range(0, n, max(1, n // 5000)):
                t = struct.unpack_from("<I", std, off + i * stride + tokoff)[0]
                if (t >> 24) == kind:
                    tok += 1
            if tok:
                print(f"{label:9} {name:40} n={n} tok={tok}")

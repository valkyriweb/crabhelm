"""Read-only lister for the dependency tar.gz. Never extracts and never executes archive content.

argv[1]: JSON limits {files, bytes, metadataRecordBytes, metadataTotalBytes, manifestCaps}
fd 3: the already-opened, regular archive file (offset 0). stdout: one JSON document.
Path policy (canonical names, roots, collisions, .bin) is enforced by the Node facade; this script
enforces what must happen while reading: caps before metadata bodies are read, entry types, and
native-binary rejection. Any problem exits non-zero with a reason on stderr.
"""
import gzip, hashlib, json, os, stat, sys, tarfile

LIMITS = json.loads(sys.argv[1])
ALLOWED_TYPES = {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.XHDTYPE}
METADATA_TYPES = {tarfile.GNUTYPE_LONGNAME, tarfile.XHDTYPE}
PAX_KEYS = {"path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"}
NATIVE_PREFIXES = (b"\x7fELF", b"MZ", b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca")
meta_total = 0


def fail(reason):
    sys.stderr.write(reason + "\n")
    sys.exit(2)


class CappedInfo(tarfile.TarInfo):
    # _proc_member runs on every parsed header (all Python versions) and before any metadata body is read.
    def _proc_member(self, archive):
        global meta_total
        if self.type not in ALLOWED_TYPES:
            raise tarfile.TarError("unsupported tar entry type %r" % (self.type,))
        if self.type in METADATA_TYPES:
            meta_total += self.size
            if self.size > LIMITS["metadataRecordBytes"] or meta_total > LIMITS["metadataTotalBytes"]:
                raise tarfile.TarError("tar metadata record exceeds cap")
        return super()._proc_member(archive)


class Hashing:
    def __init__(self, fd):
        self.f, self.sha, self.size = os.fdopen(fd, "rb", closefd=False), hashlib.sha256(), 0

    def read(self, n=-1):
        data = self.f.read(n)
        self.sha.update(data)
        self.size += len(data)
        return data


class Counting:
    def __init__(self, f, cap):
        self.f, self.cap, self.n, self.last_data = f, cap, 0, 0

    def read(self, n=-1):
        data = self.f.read(n)
        trimmed = len(data.rstrip(b"\0"))
        if trimmed:
            self.last_data = self.n + trimmed  # end offset of the last non-zero decompressed byte
        self.n += len(data)
        if self.n > self.cap:
            raise tarfile.TarError("decompressed size exceeds cap")
        return data


def main():
    fd = 3
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_size > LIMITS["bytes"]:
        fail("archive fd is not a bounded regular file")
    os.lseek(fd, 0, os.SEEK_SET)
    raw = Hashing(fd)
    max_members = LIMITS["files"] * 2
    cap = LIMITS["bytes"] + max_members * 2048 + LIMITS["metadataTotalBytes"] + 1024 * 1024
    stream = Counting(gzip.GzipFile(fileobj=raw, mode="rb"), cap)
    entries, total, files = [], 0, 0
    with tarfile.open(fileobj=stream, mode="r|", tarinfo=CappedInfo, encoding="utf-8", errors="strict") as tf:
        for info in tf:
            if len(entries) >= max_members:
                fail("too many tar members")
            extra = set(info.pax_headers) - PAX_KEYS
            if extra:
                fail("unsupported pax record: " + ",".join(sorted(extra)))
            name = info.name
            if info.isdir():
                entries.append({"path": name, "type": "dir"})
                continue
            if not info.isreg():
                fail("unsupported tar entry")
            files += 1
            total += info.size
            if files > LIMITS["files"] or total > LIMITS["bytes"]:
                fail("archive exceeds file or byte limit")
            manifest_cap = LIMITS["manifestCaps"].get(name)
            if manifest_cap is not None and info.size > manifest_cap:
                fail("manifest file exceeds cap: " + name)
            if name.endswith(".node"):
                fail("native dependency body: " + name)
            body = tf.extractfile(info)
            digest, remaining, first = hashlib.sha256(), info.size, b""
            while remaining:
                chunk = body.read(min(65536, remaining))
                if not chunk:
                    fail("truncated tar member")
                if not first:
                    first = chunk[:4]
                    if first.startswith(NATIVE_PREFIXES):
                        fail("native dependency body: " + name)
                digest.update(chunk)
                remaining -= len(chunk)
            entries.append({"path": name, "type": "file", "size": info.size, "sha256": digest.hexdigest()})
    while stream.read(65536):  # drain the rest of the gzip stream (still capped)
        pass
    if stream.last_data > tf.offset:  # everything after the tar end-of-archive marker must be zero padding
        fail("data after tar end-of-archive")
    while raw.read(1 << 20):  # bind every compressed byte, including gzip trailer
        pass
    json.dump({"archiveSha256": raw.sha.hexdigest(), "archiveSize": raw.size, "entries": entries}, sys.stdout)


try:
    main()
except SystemExit:
    raise
except Exception as exc:  # tarfile, zlib, gzip, unicode
    fail("%s: %s" % (type(exc).__name__, exc))

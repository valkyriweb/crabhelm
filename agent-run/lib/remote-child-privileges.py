"""HLM1 kernel privilege-drop helper for the remote child workload.

STATUS: implementation pending kernel proof. Nothing here is proven on a real
Linux kernel; the unit tests model syscalls with mocks only.

Caller contract (NOT verified or owned here):
  * Run as root, as `python3 -I -S`, from an install path the caller has
    verified for provenance. This module only checks the interpreter flags.
  * A trusted root setup/controller protects the runtime and allocates a
    workload UID/GID distinct from the SSH account and from root.
  * The caller owns exact argv/env policy, deadlines, process-group and
    container cleanup, and reading the receipt pipe (disconnect handling).

exec_workload() validates the plan (no state change on failure), then closes
inherited fds, drops every privilege, reads the state back, writes a numeric
pre-exec attestation to the receipt pipe, closes it and execs. Any failure
after the first state change terminates the process with _exit(126); an exec
failure terminates with _exit(127). It never returns.

The receipt attests kernel state BEFORE exec. It is not proof that exec ran.
"""
import ctypes
import fcntl
import json
import os
import errno
import re
import stat
import sys

EXIT_TRANSITION_FAILED = 126
EXIT_EXEC_FAILED = 127

_PR_GET_KEEPCAPS = 7
_PR_SET_KEEPCAPS = 8
_PR_CAPBSET_READ = 23
_PR_CAPBSET_DROP = 24
_PR_SET_NO_NEW_PRIVS = 38
_PR_GET_NO_NEW_PRIVS = 39
_PR_CAP_AMBIENT = 47
_PR_CAP_AMBIENT_IS_SET = 1
_PR_CAP_AMBIENT_CLEAR_ALL = 4
_LINUX_CAPABILITY_VERSION_3 = 0x20080522
_MAX_CAPS = 64  # two 32-bit words

_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
# Denylist of loader/runtime injection only (the workload is a compiled Bun
# binary, hence BUN_*). It is NOT a complete environment policy: the caller
# still owns the exact allowlist.
_ENV_DENY_PREFIXES = ("LD_", "DYLD_", "PYTHON", "MALLOC_", "NODE_", "BUN_", "GCONV", "BASH_FUNC_")
_ENV_DENY_NAMES = frozenset({
    "GETCONF_DIR", "HOSTALIASES", "LOCPATH", "NLSPATH", "RESOLV_HOST_CONF",
    "RES_OPTIONS", "TZDIR", "BASH_ENV", "ENV", "IFS", "LOCALDOMAIN",
})
_PLAN_KEYS = frozenset({"uid", "gid", "ssh_uid", "ssh_gid", "argv", "cwd", "env"})


class PrivilegeError(Exception):
    """Pre-transition rejection. Carries a fixed code only, never values."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _Fail(Exception):
    pass


def _is_id(value):
    return type(value) is int and 0 < value < 2**32 - 1


def _clean_str(value):
    return type(value) is str and "\0" not in value


def validate_plan(plan):
    """Return a normalised copy of plan or raise PrivilegeError(code)."""
    if type(plan) is not dict or set(plan) != _PLAN_KEYS:
        raise PrivilegeError("plan_shape")
    for key in ("uid", "gid", "ssh_uid", "ssh_gid"):
        if not _is_id(plan[key]):
            raise PrivilegeError("id_invalid")
    if plan["uid"] == plan["ssh_uid"] or plan["gid"] == plan["ssh_gid"]:
        raise PrivilegeError("id_shared_with_ssh")
    argv, cwd, env = plan["argv"], plan["cwd"], plan["env"]
    if type(argv) is not list or not argv or not all(_clean_str(a) for a in argv):
        raise PrivilegeError("argv_invalid")
    if not argv[0].startswith("/"):
        raise PrivilegeError("argv0_relative")
    if not _clean_str(cwd) or not cwd.startswith("/"):
        raise PrivilegeError("cwd_invalid")
    if type(env) is not dict:
        raise PrivilegeError("env_invalid")
    for name, value in env.items():
        if not _clean_str(name) or not _clean_str(value) or not _ENV_NAME.match(name):
            raise PrivilegeError("env_invalid")
        if name in _ENV_DENY_NAMES or name.startswith(_ENV_DENY_PREFIXES):
            raise PrivilegeError("env_injection")
    return {"uid": plan["uid"], "gid": plan["gid"], "argv": list(argv), "cwd": cwd, "env": dict(env)}


def _preflight(plan):
    if not (sys.flags.isolated and sys.flags.no_site):
        raise PrivilegeError("interpreter_not_isolated")
    if not sys.platform.startswith("linux"):
        raise PrivilegeError("unsupported_platform")
    if os.geteuid() != 0 or os.getuid() != 0:
        raise PrivilegeError("not_root")
    if plan["uid"] == 0 or plan["gid"] == 0:
        raise PrivilegeError("id_invalid")


def _check_receipt_fd(fd):
    """Validate before any mutation: controller-provided fresh write end of a pipe."""
    if type(fd) is not int or fd < 3:
        raise PrivilegeError("receipt_fd_invalid")
    try:
        mode = os.fstat(fd).st_mode
        status = fcntl.fcntl(fd, fcntl.F_GETFL)
        flags = fcntl.fcntl(fd, fcntl.F_GETFD)
    except OSError:
        raise PrivilegeError("receipt_fd_invalid") from None
    if not stat.S_ISFIFO(mode):
        raise PrivilegeError("receipt_fd_not_pipe")
    if status & os.O_ACCMODE != os.O_WRONLY:
        raise PrivilegeError("receipt_fd_not_write_end")
    try:
        fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)
    except OSError:
        raise PrivilegeError("receipt_fd_invalid") from None


# --- kernel access (the only functions that touch real syscalls via ctypes) ---

_libc_handle = None


def _libc():
    global _libc_handle
    if _libc_handle is None:
        lib = ctypes.CDLL(None, use_errno=True)
        lib.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        lib.prctl.restype = ctypes.c_int
        lib.syscall.argtypes = [ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
        # variadic in C; both capability syscalls take exactly two pointers
        lib.syscall.restype = ctypes.c_long
        _libc_handle = lib
    return _libc_handle


def _prctl(option, a2=0, a3=0, a4=0, a5=0):
    ctypes.set_errno(0)
    result = _libc().prctl(option, a2, a3, a4, a5)
    if result < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return result


class _CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class _CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


_CAP_SYSCALLS = {"x86_64": (125, 126), "aarch64": (90, 91)}  # (capget, capset)


def _cap_syscall(index, header, data):
    numbers = _CAP_SYSCALLS.get(os.uname().machine)
    if numbers is None:
        raise OSError(38, "capability syscall unknown for machine")
    ctypes.set_errno(0)
    result = _libc().syscall(numbers[index], ctypes.byref(header), data)
    if result < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def _capget():
    """Return [(effective, permitted, inheritable)] x2 words, version 3."""
    header = _CapHeader(_LINUX_CAPABILITY_VERSION_3, 0)
    data = (_CapData * 2)()
    _cap_syscall(0, header, data)
    if header.version != _LINUX_CAPABILITY_VERSION_3:
        raise OSError(22, "capability version")
    return [(d.effective, d.permitted, d.inheritable) for d in data]


def _capset_zero():
    header = _CapHeader(_LINUX_CAPABILITY_VERSION_3, 0)
    data = (_CapData * 2)()
    _cap_syscall(1, header, data)


def _read_status():
    with open("/proc/self/status", "rb") as handle:
        return handle.read().decode("ascii", "strict")


def _parse_status(text):
    fields = {}
    for line in text.splitlines():
        name, sep, rest = line.partition(":")
        if sep:
            fields[name] = rest.strip()
    try:
        ids = {}
        for key in ("Uid", "Gid"):
            parts = fields[key].split()
            if len(parts) != 4:
                raise _Fail
            ids[key] = tuple(int(p) for p in parts)
        caps = {key: int(fields[key], 16) for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")}
        return {"uid": ids["Uid"], "gid": ids["Gid"], "groups": fields["Groups"].split(),
                "caps": caps, "nnp": int(fields["NoNewPrivs"])}
    except (KeyError, ValueError):
        raise _Fail from None


# --- transitions ---

def _cap_count():
    for cap in range(_MAX_CAPS):
        try:
            _prctl(_PR_CAPBSET_READ, cap)
        except OSError as exc:
            if exc.errno == 22 and cap > 0:
                return cap
            raise
    return _MAX_CAPS


def _drop_all(uid, gid):
    _prctl(_PR_SET_KEEPCAPS, 0)
    _prctl(_PR_CAP_AMBIENT, _PR_CAP_AMBIENT_CLEAR_ALL)
    count = _cap_count()
    for cap in range(count):
        if _prctl(_PR_CAPBSET_READ, cap):
            _prctl(_PR_CAPBSET_DROP, cap)
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    _capset_zero()
    _prctl(_PR_SET_NO_NEW_PRIVS, 1)
    return count


def _regain_root_refused():
    try:
        os.setresuid(0, 0, 0)
    except PermissionError:
        return True
    return False


def _verify(uid, gid, count):
    """Read state back through independent routes; raise _Fail on any gap."""
    triple = (uid, uid, uid)
    if os.getresuid() != triple or os.getresgid() != (gid, gid, gid):
        raise _Fail
    if os.getgroups() != []:
        raise _Fail
    if _prctl(_PR_GET_NO_NEW_PRIVS) != 1 or _prctl(_PR_GET_KEEPCAPS) != 0:
        raise _Fail
    for cap in range(count):
        if _prctl(_PR_CAPBSET_READ, cap) != 0 or _prctl(_PR_CAP_AMBIENT, _PR_CAP_AMBIENT_IS_SET, cap) != 0:
            raise _Fail
    if any(word != (0, 0, 0) for word in _capget()):
        raise _Fail
    if not _regain_root_refused():
        raise _Fail
    state = _parse_status(_read_status())
    if state["uid"] != (uid,) * 4 or state["gid"] != (gid,) * 4 or state["groups"]:
        raise _Fail
    if any(state["caps"].values()) or state["nnp"] != 1:
        raise _Fail
    return state


def _receipt_bytes(state):
    body = {"v": 1, "kind": "preexec-attestation",
            "uid": list(state["uid"]), "gid": list(state["gid"]), "groups": 0,
            "caps": {k: v for k, v in sorted(state["caps"].items())},
            "nnp": state["nnp"], "keepcaps": 0}
    return (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise _Fail
        view = view[written:]


def _close_inherited(receipt_fd):
    """Close every actual open fd >= 3 except receipt_fd (Linux /proc only).

    EBADF is ignored only for stale entries (e.g. the listing's own dir fd);
    any other enumeration or close failure is fatal.
    """
    for name in os.listdir("/proc/self/fd"):
        if not name.isascii() or not name.isdigit():
            raise _Fail
        fd = int(name)
        if fd < 3 or fd == receipt_fd:
            continue
        try:
            os.close(fd)
        except OSError as exc:
            if exc.errno != errno.EBADF:
                raise


def exec_workload(plan, receipt_fd):
    """Drop all privileges, attest numerically on receipt_fd, exec. Never returns."""
    clean = validate_plan(plan)
    _preflight(clean)
    _check_receipt_fd(receipt_fd)
    try:
        _close_inherited(receipt_fd)
        count = _drop_all(clean["uid"], clean["gid"])
        os.chdir(clean["cwd"])
        state = _verify(clean["uid"], clean["gid"], count)
        _write_all(receipt_fd, _receipt_bytes(state))
        os.close(receipt_fd)
    except BaseException:
        os._exit(EXIT_TRANSITION_FAILED)
    try:
        os.execve(clean["argv"][0], clean["argv"], clean["env"])
    except BaseException:
        pass
    os._exit(EXIT_EXEC_FAILED)

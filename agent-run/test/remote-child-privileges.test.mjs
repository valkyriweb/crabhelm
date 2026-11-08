import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Portable: runs the helper under `python3 -I -S` with every kernel call mocked.
// No privilege change, exec, /proc read or Linux behaviour is exercised or proven.
const helper = fileURLToPath(new URL("../lib/remote-child-privileges.py", import.meta.url));
const python = process.env.PYTHON3 || "/usr/bin/python3";

const PY = String.raw`
import importlib.util, json, os, stat, sys, unittest
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("rcp", sys.argv[1])
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

NCAPS = 41
class Exit(BaseException):
    def __init__(self, code): self.code = code

class Kernel:
    """Model of the syscalls used; every mocked call is recorded in order."""
    def __init__(self, fail=None):
        self.fail = fail or {}
        self.log = []
        self.ids = {"u": [0, 0, 0], "g": [0, 0, 0]}
        self.groups = [4, 27]
        self.bnd = set(range(NCAPS)); self.amb = {1}
        self.cap = [(0xffffffff, 0xffffffff, 0)] * 2
        self.keep = 1; self.nnp = 0; self.cwd = "/"
        self.closed = []; self.writes = []; self.env = None
        self.cloexec = False
    def hit(self, name):
        self.log.append(name)
        if name in self.fail:
            raise self.fail[name] if isinstance(self.fail[name], BaseException) else OSError(self.fail[name], "x")
    def prctl(self, opt, a2=0, a3=0, a4=0, a5=0):
        self.hit("prctl:%d" % opt if opt != 47 else "prctl:47:%d" % a2)
        if opt == 8: self.keep = a2; return 0
        if opt == 7: return self.keep
        if opt == 47:
            if a2 == 4: self.amb = set(); return 0
            if a2 == 1: return int(a3 in self.amb)
        if opt == 23:
            if a2 >= NCAPS: raise OSError(22, "inval")
            return int(a2 in self.bnd)
        if opt == 24: self.bnd.discard(a2); return 0
        if opt == 38: self.nnp = a2; return 0
        if opt == 39: return self.nnp
        raise AssertionError(opt)
    def setgroups(self, g): self.hit("setgroups"); self.groups = list(g)
    def setresgid(self, *a): self.hit("setresgid"); self.ids["g"] = list(a)
    def setresuid(self, *a):
        self.hit("setresuid")
        if a == (0, 0, 0) and 0 not in self.ids["u"]: raise PermissionError(1, "perm")
        self.ids["u"] = list(a)
    def capset(self): self.hit("capset"); self.cap = [(0, 0, 0)] * 2
    def status(self):
        self.hit("status")
        u, g = self.ids["u"], self.ids["g"]
        c = lambda v: "%016x" % v
        return ("Uid:\t%d\t%d\t%d\t%d\nGid:\t%d\t%d\t%d\t%d\nGroups:\t%s\n" % (*u, u[1], *g, g[1], " ".join(map(str, self.groups)))
            + "CapInh:\t%s\nCapPrm:\t%s\nCapEff:\t%s\nCapBnd:\t%s\nCapAmb:\t%s\nNoNewPrivs:\t%d\n" % (
                c(0), c(0 if self.ids["u"][1] else 2**40-1), c(0 if self.ids["u"][1] else 2**40-1),
                c(sum(1 << i for i in self.bnd)), c(sum(1 << i for i in self.amb)), self.nnp))

def run_plan(plan=None, kernel=None, fd=7, euid=0, flags=(1, 1), fstat_mode=stat.S_IFIFO, getfl=os.O_WRONLY, listing=("0", "1", "2", "7"), close_fail=None):
    k = kernel or Kernel()
    plan = plan or good_plan()
    k.fcntl_calls = []
    def write(f, d): k.hit("write"); k.writes.append(bytes(d)); return len(d)
    def execve(path, argv, env): k.hit("execve"); k.env = (path, argv, env)
    def fcntl_(f, cmd, arg=0):
        k.fcntl_calls.append(cmd)
        if cmd == M.fcntl.F_SETFD: k.cloexec = bool(arg & M.fcntl.FD_CLOEXEC); return 0
        if cmd == M.fcntl.F_GETFL: return getfl
        return 0
    def getresuid(): k.log.append("getresuid"); return tuple(k.ids["u"])
    def getresgid(): k.log.append("getresgid"); return tuple(k.ids["g"])
    def getgroups(): k.log.append("getgroups"); return list(k.groups)
    def chdir(p): k.hit("chdir"); k.cwd = p
    def _exit(code): k.log.append("_exit"); raise Exit(code)
    def close(f):
        if f == fd: k.hit("close"); return
        k.log.append("closefd"); k.closed.append(f)
        if close_fail and f in close_fail: raise OSError(close_fail[f], "x")
    def capget(): k.hit("capget"); return list(k.cap)
    patches = [
        mock.patch.object(M.sys, "flags", SimpleNamespace(isolated=flags[0], no_site=flags[1])),
        mock.patch.object(M.sys, "platform", "linux"),
        mock.patch.object(M.os, "geteuid", lambda: euid), mock.patch.object(M.os, "getuid", lambda: euid),
        mock.patch.object(M.os, "fstat", lambda f: SimpleNamespace(st_mode=fstat_mode)),
        mock.patch.object(M.fcntl, "fcntl", fcntl_),
        mock.patch.object(M.os, "listdir", lambda p: (k.log.append("listdir"), list(listing))[1]),
        mock.patch.object(M, "_prctl", k.prctl), mock.patch.object(M, "_capget", capget),
        mock.patch.object(M, "_capset_zero", k.capset), mock.patch.object(M, "_read_status", k.status),
        mock.patch.object(M.os, "setgroups", k.setgroups), mock.patch.object(M.os, "setresgid", create=True, new=k.setresgid),
        mock.patch.object(M.os, "setresuid", create=True, new=k.setresuid), mock.patch.object(M.os, "getresuid", create=True, new=getresuid),
        mock.patch.object(M.os, "getresgid", create=True, new=getresgid), mock.patch.object(M.os, "getgroups", getgroups),
        mock.patch.object(M.os, "chdir", chdir), mock.patch.object(M.os, "write", write),
        mock.patch.object(M.os, "close", close), mock.patch.object(M.os, "execve", execve),
        mock.patch.object(M.os, "_exit", _exit),
    ]
    for p in patches: p.start()
    code = None; err = None
    try:
        try: M.exec_workload(plan, receipt_fd=fd); code = "returned"
        except Exit as e: code = e.code
        except M.PrivilegeError as e: err = e.code
    finally:
        for p in reversed(patches): p.stop()
    return k, code, err

def good_plan(**kw):
    p = {"uid": 2001, "gid": 2002, "ssh_uid": 1000, "ssh_gid": 1000, "argv": ["/opt/pi/bin/pi", "--x"],
         "cwd": "/work", "env": {"HOME": "/work", "PATH": "/usr/bin"}}
    p.update(kw); return p

class T(unittest.TestCase):
    def test_import_is_pure(self):
        with mock.patch("ctypes.CDLL", side_effect=AssertionError("syscall on import")):
            s = importlib.util.spec_from_file_location("rcp2", sys.argv[1])
            m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
        self.assertIsNone(m._libc_handle)

    def test_exact_final_state_and_exec_args(self):
        k, code, err = run_plan()
        self.assertEqual(code, M.EXIT_EXEC_FAILED)  # mock execve returns => treated as non-return failure
        self.assertEqual(k.ids, {"u": [2001] * 3, "g": [2002] * 3})
        self.assertEqual((k.groups, k.bnd, k.amb, k.keep, k.nnp, k.cwd), ([], set(), set(), 0, 1, "/work"))
        self.assertEqual(k.cap, [(0, 0, 0)] * 2)
        self.assertEqual(k.env, ("/opt/pi/bin/pi", ["/opt/pi/bin/pi", "--x"], {"HOME": "/work", "PATH": "/usr/bin"}))

    def test_order_ambient_bounding_while_privileged(self):
        k, _, _ = run_plan()
        i = k.log.index
        self.assertLess(i("prctl:8"), i("prctl:47:4")); self.assertLess(i("prctl:24"), i("setgroups"))
        self.assertLess(i("setgroups"), i("setresgid")); self.assertLess(i("setresgid"), i("setresuid"))
        self.assertLess(i("setresuid"), i("capset")); self.assertLess(i("capset"), i("prctl:38"))
        self.assertLess(i("listdir"), i("prctl:8"))

    def test_receipt_numeric_only_before_exec_and_closed(self):
        k, _, _ = run_plan(); r = json.loads(k.writes[0])
        self.assertLess(k.log.index("write"), k.log.index("close")); self.assertLess(k.log.index("close"), k.log.index("execve"))
        self.assertTrue(k.cloexec)
        self.assertEqual(r["kind"], "preexec-attestation"); self.assertEqual(r["uid"], [2001] * 4)
        self.assertEqual(r["nnp"], 1); self.assertEqual(set(r["caps"].values()), {0})
        raw = k.writes[0].decode()
        for secret in ("pi", "/work", "HOME", "PATH", "argv", "env"): self.assertNotIn(secret, raw)

    def test_fd_closure_actual_fds_not_limit_based(self):
        # fds far above any rlimit-style bound are closed; stdio and receipt kept
        k, _, _ = run_plan(fd=9, listing=("0", "1", "2", "3", "9", "5000000", "70000"))
        self.assertEqual(sorted(k.closed), [3, 70000, 5000000])
        self.assertFalse(hasattr(M, "resource"))

    def test_close_ebadf_tolerated_other_errors_fatal(self):
        k, code, _ = run_plan(listing=("0", "3", "7", "8"), close_fail={8: 9})
        self.assertEqual(code, M.EXIT_EXEC_FAILED); self.assertIn("execve", k.log)
        k, code, _ = run_plan(listing=("0", "3", "7", "8"), close_fail={3: 5})
        self.assertEqual(code, M.EXIT_TRANSITION_FAILED); self.assertNotIn("execve", k.log)
        self.assertNotIn("prctl:8", k.log)
        k, code, _ = run_plan(listing=("3", "x"))
        self.assertEqual(code, M.EXIT_TRANSITION_FAILED); self.assertNotIn("execve", k.log)

    def test_nonpipe_or_readonly_fd_no_mutation(self):
        k, code, err = run_plan(fstat_mode=stat.S_IFREG)
        self.assertEqual(err, "receipt_fd_not_pipe"); self.assertNotIn(M.fcntl.F_SETFD, k.fcntl_calls); self.assertFalse(k.cloexec)
        k, code, err = run_plan(getfl=os.O_RDONLY)
        self.assertEqual(err, "receipt_fd_not_write_end"); self.assertNotIn(M.fcntl.F_SETFD, k.fcntl_calls); self.assertEqual(k.log, [])
        k, code, err = run_plan(getfl=os.O_RDWR); self.assertEqual(err, "receipt_fd_not_write_end")

    def test_exec_failure_never_returns_success(self):
        k = Kernel(fail={"execve": 2}); k2, code, _ = run_plan(kernel=k)
        self.assertEqual(code, M.EXIT_EXEC_FAILED); self.assertNotEqual(code, "returned")

    def test_fail_fast_families(self):
        for name in ("prctl:8", "prctl:47:4", "prctl:24", "setgroups", "setresgid", "setresuid", "capset", "prctl:38", "chdir", "write", "close", "status"):
            with self.subTest(name):
                k, code, err = run_plan(kernel=Kernel(fail={name: 1}))
                self.assertEqual(code, M.EXIT_TRANSITION_FAILED); self.assertNotIn("execve", k.log)

    def test_capability_boundary_errno(self):
        k, code, _ = run_plan(kernel=Kernel(fail={"prctl:23": 1}))   # non-EINVAL errno on bounding read
        self.assertEqual(code, M.EXIT_TRANSITION_FAILED); self.assertNotIn("execve", k.log)
        k2 = Kernel()   # cap 0 immediately EINVAL: unsupported => fail closed
        orig = k2.prctl
        def bad(opt, a2=0, *a):
            if opt == 23: raise OSError(22, "inval")
            return orig(opt, a2, *a)
        k2.prctl = bad
        _, code, _ = run_plan(kernel=k2); self.assertEqual(code, M.EXIT_TRANSITION_FAILED)

    def test_partial_readback_fails_closed(self):
        cases = {
            "nnp": lambda k: setattr(k, "prctl", (lambda o, a2=0, *a, _p=k.prctl: 0 if o == 39 else _p(o, a2, *a))),
            "caps": lambda k: setattr(k, "capset", lambda: k.log.append("capset")),
            "groups": lambda k: setattr(k, "setgroups", lambda g: k.log.append("setgroups")),
            "gid": lambda k: setattr(k, "setresgid", lambda *a: k.log.append("setresgid")),
        }
        for name, tweak in cases.items():
            with self.subTest(name):
                k = Kernel(); tweak(k); k2, code, _ = run_plan(kernel=k)
                self.assertEqual(code, M.EXIT_TRANSITION_FAILED); self.assertNotIn("execve", k2.log)

    def test_status_missing_field_fails_closed(self):
        k = Kernel(); k.status = lambda: "Uid:\t1\t1\t1\t1\n"
        _, code, _ = run_plan(kernel=k); self.assertEqual(code, M.EXIT_TRANSITION_FAILED)

    def test_regain_root_succeeding_fails_closed(self):
        k = Kernel()
        def sru(*a):
            k.log.append("setresuid"); k.ids["u"] = list(a)
        k.setresuid = sru
        k2, code, _ = run_plan(kernel=k)
        self.assertEqual(code, M.EXIT_TRANSITION_FAILED); self.assertNotIn("execve", k2.log)

    def test_shared_or_root_ids_rejected_without_state_change(self):
        for kw in ({"uid": 1000}, {"gid": 1000}, {"uid": 0}, {"gid": 0}, {"uid": True}, {"uid": -5}, {"uid": "5"}):
            with self.subTest(kw):
                k, code, err = run_plan(plan=good_plan(**kw))
                self.assertIsNone(code); self.assertIn(err, ("id_invalid", "id_shared_with_ssh")); self.assertEqual(k.log, [])

    def test_env_injection_nul_and_no_value_leak(self):
        bad_names = ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "NODE_OPTIONS", "BUN_INSTALL", "BUN_CONFIG_X", "GCONV_PATH", "BASH_ENV", "MALLOC_CONF", "A=B", "", "1X", "A\0B"]
        for n in bad_names:
            with self.subTest(n):
                k, code, err = run_plan(plan=good_plan(env={n: "v"})); self.assertIsNotNone(err); self.assertEqual(k.log, [])
        secret = "s3cr3t\0x"
        with self.assertRaises(M.PrivilegeError) as cm: M.validate_plan(good_plan(env={"K": secret}))
        self.assertNotIn("s3cr3t", repr(cm.exception)); self.assertNotIn("s3cr3t", str(cm.exception))
        self.assertIsNone(cm.exception.__context__)

    def test_plan_shape_rejections(self):
        for kw in ({"argv": ["rel"]}, {"argv": []}, {"argv": ["/a", 1]}, {"argv": ["/a\0"]}, {"cwd": "rel"}, {"cwd": "/a\0"}, {"env": []}, {"env": {"A": 1}}):
            with self.subTest(kw): self.assertIsNotNone(run_plan(plan=good_plan(**kw))[2])
        bad = good_plan(); bad["extra"] = 1
        self.assertEqual(run_plan(plan=bad)[2], "plan_shape")

    def test_preflight_refusals(self):
        self.assertEqual(run_plan(flags=(0, 1))[2], "interpreter_not_isolated")
        self.assertEqual(run_plan(flags=(1, 0))[2], "interpreter_not_isolated")
        self.assertEqual(run_plan(euid=1000)[2], "not_root")
        k, _, err = run_plan(fstat_mode=stat.S_IFREG); self.assertEqual(err, "receipt_fd_not_pipe")
        for fd in (0, 2, -1, "7", True):
            self.assertEqual(run_plan(fd=fd)[2], "receipt_fd_invalid")

    def test_cap_abi_structure(self):
        import ctypes
        self.assertEqual(ctypes.sizeof(M._CapHeader), 8); self.assertEqual(ctypes.sizeof(M._CapData), 12)
        self.assertEqual(M._LINUX_CAPABILITY_VERSION_3, 0x20080522); self.assertEqual(M._MAX_CAPS, 64)

if __name__ == "__main__":
    res = unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(unittest.defaultTestLoader.loadTestsFromTestCase(T))
    bad = {str(t): tb for t, tb in res.failures + res.errors}
    names = [m for m in dir(T) if m.startswith("test_")]
    print(json.dumps({"names": names, "failed": bad}))
`;

const run = spawnSync(python, ["-I", "-S", "-c", PY, helper], { encoding: "utf8" });
assert.equal(run.status, 0, run.stderr);
const { names, failed } = JSON.parse(run.stdout);

for (const name of names) {
  test(`privilege helper: ${name.replace(/^test_/, "").replaceAll("_", " ")}`, () => {
    const hit = Object.entries(failed).filter(([k]) => k.startsWith(`${name} `));
    assert.deepEqual(hit, []);
  });
}

test("privilege helper: python suite ran every case", () => {
  assert.ok(names.length >= 15);
});

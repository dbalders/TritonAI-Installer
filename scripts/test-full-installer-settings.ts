const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { getPaths } = require("../src/installer/paths");
const {
  writeT3CodeSettings,
  __test: { verifyPrivateManagedSettingsAccess }
} = require("../src/installer/config-writers");

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-full-settings-"));
  const paths = getPaths(root, process.platform);
  fs.mkdirSync(path.dirname(paths.t3Settings), { recursive: true });
  try {
    run(paths);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function backups(paths) {
  return fs.readdirSync(path.dirname(paths.t3Settings))
    .filter((name) => name.startsWith("settings.json.backup-"))
    .map((name) => path.join(path.dirname(paths.t3Settings), name));
}

function install(paths) {
  writeT3CodeSettings(paths, { replaceExisting: true });
}

function assertFreshSettings(paths) {
  const settings = JSON.parse(fs.readFileSync(paths.t3Settings, "utf8"));
  assert.strictEqual(settings.oldPreference, undefined);
  assert.strictEqual(settings.providerInstances.codex.enabled, true);
  assert.strictEqual(settings.providerInstances.codex.config.homePath, paths.codexHome);
  verifyPrivateManagedSettingsAccess(paths.t3Settings, { platform: paths.platform });
}

function assertFullInstallerReplacesAndKeepsEveryBackup() {
  withFixture((paths) => {
    const otherFiles = [
      path.join(path.dirname(paths.t3Settings), "state.sqlite"),
      path.join(paths.t3Home, "dev", "settings.json")
    ];
    for (const file of otherFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "unrelated user state");
    }
    const originals = [
      Buffer.from('{"oldPreference":true,"providers":{"obsolete":{"enabled":true}}}'),
      Buffer.from("{invalid JSON"),
      Buffer.from([0xff, 0x00, 0x80, 0x0a]),
      Buffer.alloc(0)
    ];
    originals.forEach((original, index) => {
      fs.writeFileSync(paths.t3Settings, original);
      install(paths);
      assertFreshSettings(paths);
      const saved = backups(paths).map((file) => fs.readFileSync(file));
      assert.strictEqual(saved.length, index + 1);
      for (const expected of originals.slice(0, index + 1)) {
        assert(saved.some((bytes) => bytes.equals(expected)), "each original must survive byte-for-byte");
      }
      for (const file of otherFiles) assert.strictEqual(fs.readFileSync(file, "utf8"), "unrelated user state");
    });
  });
}

function assertFullInstallerDoesNotReadOrCheckOldOwner() {
  withFixture((paths) => {
    const original = "old settings with an unrelated Windows owner";
    fs.writeFileSync(paths.t3Settings, original);
    const originalRead = fs.readFileSync;
    paths.platform = "win32";
    paths.windowsAclRunner = (file, action, content) => {
      assert.notStrictEqual(action, "verify-owner", "full installation must not gate on the old owner");
      assert(!String(file).includes("settings.json.backup-"), "moving the old file must preserve its ACL");
      if (action === "create") fs.writeFileSync(file, content, { flag: "wx" });
    };
    fs.readFileSync = (file, ...args) => {
      if (file === paths.t3Settings || String(file).includes("settings.json.backup-")) {
        throw new Error("old settings are unreadable");
      }
      return originalRead(file, ...args);
    };
    try {
      install(paths);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.strictEqual(backups(paths).length, 1);
    assert.strictEqual(fs.readFileSync(backups(paths)[0], "utf8"), original);
    assert.strictEqual(JSON.parse(fs.readFileSync(paths.t3Settings, "utf8")).oldPreference, undefined);
  });
}

function assertFullInstallerRollbackAndFailures() {
  for (const failure of ["stage", "backup", "publish", "verify"]) {
    withFixture((paths) => {
      const original = '{"oldPreference":"keep on failure"}';
      fs.writeFileSync(paths.t3Settings, original);
      paths.platform = "win32";
      paths.windowsAclRunner = (file, action, content) => {
        if ((failure === "stage" && action === "create") ||
            (failure === "verify" && action === "verify" && file === paths.t3Settings)) {
          throw new Error(`simulated ${failure} failure`);
        }
        if (action === "create") fs.writeFileSync(file, content, { flag: "wx" });
      };
      const rename = fs.renameSync;
      const link = fs.linkSync;
      fs.renameSync = (from, to) => {
        if (failure === "backup" && from === paths.t3Settings) throw new Error("simulated backup failure");
        return rename(from, to);
      };
      fs.linkSync = (from, to) => {
        if (failure === "publish" && to === paths.t3Settings && String(from).includes(".replacement-")) {
          throw new Error("simulated publish failure");
        }
        return link(from, to);
      };
      try {
        assert.throws(() => install(paths), new RegExp(`simulated ${failure} failure`));
      } finally {
        fs.renameSync = rename;
        fs.linkSync = link;
      }
      assert.strictEqual(fs.readFileSync(paths.t3Settings, "utf8"), original);
      assert.deepStrictEqual(backups(paths), [], "successful rollback must not leave the backup linked to live settings");
      assert(!fs.readdirSync(path.dirname(paths.t3Settings)).some((name) => name.includes(".replacement-")));
    });
  }
}

function assertUnsupportedHardLinksLeaveOriginalInPlace() {
  withFixture((paths) => {
    const original = '{"oldPreference":"keep on unsupported filesystem"}';
    fs.writeFileSync(paths.t3Settings, original);
    const before = fs.lstatSync(paths.t3Settings);
    const link = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }); };
    try {
      assert.throws(() => install(paths), /hard links unsupported/);
    } finally {
      fs.linkSync = link;
    }
    assert.strictEqual(fs.readFileSync(paths.t3Settings, "utf8"), original);
    assert.strictEqual(fs.lstatSync(paths.t3Settings).ino, before.ino);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(paths.t3Settings)), ["settings.json"]);
  });
}

function assertConcurrentCreationIsNotClobbered() {
  for (const existing of [false, true]) {
    withFixture((paths) => {
      const original = '{"oldPreference":true}';
      const concurrent = '{"concurrent":true}';
      if (existing) fs.writeFileSync(paths.t3Settings, original);
      const link = fs.linkSync;
      fs.linkSync = (from, to) => {
        if (to === paths.t3Settings && String(from).includes(".replacement-")) {
          fs.writeFileSync(to, concurrent);
        }
        return link(from, to);
      };
      try {
        assert.throws(() => install(paths), /EEXIST/);
      } finally {
        fs.linkSync = link;
      }
      assert.strictEqual(fs.readFileSync(paths.t3Settings, "utf8"), concurrent);
      if (existing) assert.strictEqual(fs.readFileSync(backups(paths)[0], "utf8"), original);
    });
  }
}

function assertConcurrentEditsSurviveFailure() {
  for (const phase of ["stage", "verify"]) {
    withFixture((paths) => {
      const original = '{"oldPreference":true}';
      const concurrent = '{"concurrent":"must survive"}';
      fs.writeFileSync(paths.t3Settings, original);
      paths.platform = "win32";
      paths.windowsAclRunner = (file, action, content) => {
        if (action === "create") {
          fs.writeFileSync(file, content, { flag: "wx" });
          if (phase === "stage") fs.writeFileSync(paths.t3Settings, concurrent);
        }
        if (phase === "verify" && action === "verify" && file === paths.t3Settings) {
          fs.unlinkSync(file);
          fs.writeFileSync(file, concurrent);
          throw new Error("verification failed after concurrent replacement");
        }
      };
      assert.throws(() => install(paths), /concurrently changed/);
      assert.strictEqual(fs.readFileSync(paths.t3Settings, "utf8"), concurrent);
      if (phase === "verify") assert.strictEqual(fs.readFileSync(backups(paths)[0], "utf8"), original);
      else assert.deepStrictEqual(backups(paths), []);
    });
  }
}

function assertNativeWindowsAdministratorsOwnerIsRecoverable() {
  if (process.platform !== "win32") return;
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const elevated = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 2 }"
  ], { encoding: "utf8", windowsHide: true });
  if (elevated.status === 2) {
    console.log("Native Administrators-owner fixture skipped: this Windows process is not elevated.");
    return;
  }
  assert.strictEqual(elevated.status, 0, elevated.stderr);
  withFixture((paths) => {
    const original = '{"oldPreference":"Administrators-owned settings"}';
    fs.writeFileSync(paths.t3Settings, original);
    const result = spawnSync(path.join(process.env.SystemRoot, "System32", "icacls.exe"),
      [paths.t3Settings, "/setowner", "*S-1-5-32-544"], { encoding: "utf8", windowsHide: true });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.throws(() => writeT3CodeSettings(paths), /Managed settings owner is not the installing user/);
    install(paths);
    assertFreshSettings(paths);
    assert.strictEqual(fs.readFileSync(backups(paths)[0], "utf8"), original);
  });
}

function assertRedirectedSettingsAreRejected() {
  for (const target of ["home", "userdata", "file", "dangling-file"]) {
    withFixture((paths) => {
      const external = path.join(paths.homeDir, "external");
      fs.mkdirSync(external);
      const externalFile = path.join(external, "settings.json");
      fs.writeFileSync(externalFile, "leave outside state alone");
      const linkPath = target === "home" ? paths.t3Home
        : target === "userdata" ? path.dirname(paths.t3Settings) : paths.t3Settings;
      if (target === "home" || target === "userdata") {
        fs.rmSync(linkPath, { recursive: true });
        fs.symlinkSync(external, linkPath, process.platform === "win32" ? "junction" : "dir");
      } else {
        // File symlinks require Developer Mode or elevation on Windows; directory junctions above do not.
        if (process.platform === "win32") return;
        fs.symlinkSync(target === "dangling-file" ? path.join(external, "missing") : externalFile, linkPath);
      }
      assert.throws(() => install(paths), /regular file|directory|redirect/);
      assert.strictEqual(fs.readFileSync(externalFile, "utf8"), "leave outside state alone");
      assert.deepStrictEqual(fs.readdirSync(external), ["settings.json"]);
    });
  }
}

function assertPatcherKeepsSettingsAndInstallerBackup() {
  withFixture((paths) => {
    const original = '{"oldPreference":"before installer"}';
    fs.writeFileSync(paths.t3Settings, original);
    install(paths);
    const settings = JSON.parse(fs.readFileSync(paths.t3Settings, "utf8"));
    settings.newPreference = "after installer";
    fs.writeFileSync(paths.t3Settings, JSON.stringify(settings));
    const result = spawnSync(process.execPath, [paths.t3DefaultsPatcher], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(paths.t3Settings, "utf8")).newPreference, "after installer");
    assert.strictEqual(backups(paths).length, 1);
    assert.strictEqual(fs.readFileSync(backups(paths)[0], "utf8"), original);
  });
}

assertFullInstallerReplacesAndKeepsEveryBackup();
assertFullInstallerDoesNotReadOrCheckOldOwner();
assertFullInstallerRollbackAndFailures();
assertUnsupportedHardLinksLeaveOriginalInPlace();
assertConcurrentCreationIsNotClobbered();
assertConcurrentEditsSurviveFailure();
assertNativeWindowsAdministratorsOwnerIsRecoverable();
assertRedirectedSettingsAreRejected();
assertPatcherKeepsSettingsAndInstallerBackup();
console.log("Full installer settings replacement tests passed.");

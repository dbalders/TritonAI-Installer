const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const certPath = process.argv[2] && path.resolve(process.argv[2]);
const secretsDir = path.join(os.homedir(), ".agents", "secrets", "developer-id-desktop-installer");
const privateKeyPath = path.join(secretsDir, "DeveloperIDApplication.private.key");
const pemPath = path.join(secretsDir, "DeveloperIDApplication.certificate.pem");
const p12Path = path.join(secretsDir, "DeveloperIDApplication.identity.p12");
const p12PasswordPath = path.join(secretsDir, "DeveloperIDApplication.identity.p12.password");

function main() {
  if (process.platform !== "darwin") {
    throw new Error("Developer ID certificate import must run on macOS.");
  }
  if (!certPath || !fs.existsSync(certPath)) {
    throw new Error("Usage: npm run mac:import-developer-id-cert -- /path/to/developerID_application.cer");
  }
  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(`Missing private key. Run npm run mac:prepare-developer-id-csr first.\nExpected: ${privateKeyPath}`);
  }

  execFileSync("openssl", ["x509", "-inform", "DER", "-in", certPath, "-out", pemPath], {
    stdio: "inherit"
  });
  fs.chmodSync(pemPath, 0o600);

  const p12Password = p12PasswordForImport();

  execFileSync("openssl", [
    "pkcs12",
    "-export",
    "-legacy",
    "-inkey",
    privateKeyPath,
    "-in",
    pemPath,
    "-out",
    p12Path,
    "-name",
    "Developer ID Application",
    "-passout",
    `pass:${p12Password}`
  ], { stdio: "inherit" });
  fs.chmodSync(p12Path, 0o600);

  execFileSync("security", [
    "import",
    p12Path,
    "-k",
    path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    "-P",
    p12Password,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/productsign"
  ], { stdio: "inherit" });

  if (process.env.CODESIGN_KEYCHAIN_PASSWORD) {
    execFileSync("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      process.env.CODESIGN_KEYCHAIN_PASSWORD,
      path.join(os.homedir(), "Library", "Keychains", "login.keychain-db")
    ], { stdio: "inherit" });
  } else {
    console.log("Skipping key partition update because CODESIGN_KEYCHAIN_PASSWORD is not set.");
    console.log("If macOS prompts for codesign key access during release packaging, choose Always Allow.");
  }

  execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { stdio: "inherit" });
  console.log("Developer ID certificate import complete.");
}

function p12PasswordForImport() {
  if (fs.existsSync(p12PasswordPath)) {
    return fs.readFileSync(p12PasswordPath, "utf8").trim();
  }

  const password = crypto.randomBytes(24).toString("base64");
  fs.writeFileSync(p12PasswordPath, `${password}\n`, { mode: 0o600 });
  return password;
}

main();

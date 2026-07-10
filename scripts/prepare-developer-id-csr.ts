const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const secretsDir = path.join(os.homedir(), ".agents", "secrets", "developer-id-desktop-installer");
const privateKeyPath = path.join(secretsDir, "DeveloperIDApplication.private.key");
const csrPath = path.join(secretsDir, "DeveloperIDApplication.certSigningRequest");
const instructionsPath = path.join(secretsDir, "README.md");

function main() {
  if (process.platform !== "darwin") {
    throw new Error("Developer ID CSR generation must run on macOS.");
  }

  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(privateKeyPath)) {
    execFileSync("openssl", ["genrsa", "-out", privateKeyPath, "2048"], { stdio: "inherit" });
    fs.chmodSync(privateKeyPath, 0o600);
  }

  const subject = certificateSubject();
  execFileSync("openssl", ["req", "-new", "-key", privateKeyPath, "-out", csrPath, "-subj", subject], {
    stdio: "inherit"
  });
  fs.chmodSync(csrPath, 0o600);

  fs.writeFileSync(instructionsPath, instructions(subject), { mode: 0o600 });

  console.log(`CSR ready: ${csrPath}`);
  console.log(`Private key kept local: ${privateKeyPath}`);
  console.log(`Instructions: ${instructionsPath}`);
}

function certificateSubject() {
  const commonName = process.env.APPLE_CERT_COMMON_NAME
    || gitConfig("user.name")
    || os.userInfo().username;
  const email = process.env.APPLE_CERT_EMAIL
    || gitConfig("user.email")
    || "developer@example.com";

  return `/emailAddress=${escapeSubject(email)}/CN=${escapeSubject(commonName)}/C=US`;
}

function gitConfig(key) {
  try {
    return execFileSync("git", ["config", "--get", key], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function escapeSubject(value) {
  return String(value).replace(/[\\/]/g, "\\$&");
}

function instructions(subject) {
  return `# Developer ID Application Certificate

Upload this CSR in Apple Developer:

\`${csrPath}\`

Use:

1. https://developer.apple.com/account/resources/certificates/list
2. Add certificate
3. Software > Developer ID
4. Select "Developer ID Application"
5. Upload the CSR above
6. Download the generated .cer file

Then import the downloaded certificate with:

\`\`\`sh
npm run mac:import-developer-id-cert -- ~/Downloads/developerID_application.cer
\`\`\`

Keep this private key. It is the matching key for the CSR:

\`${privateKeyPath}\`

CSR subject used:

\`${subject}\`
`;
}

main();

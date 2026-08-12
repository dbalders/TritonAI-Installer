import * as fs from "node:fs";
import * as path from "node:path";

const SMOKE_MARKER_ARGUMENT = "--tritonai-installer-smoke-marker=";
const SMOKE_MARKER_ENVIRONMENT = "TRITONAI_INSTALLER_SMOKE_MARKER";
const SMOKE_MARKER_NAME = /^tritonai-installer-smoke-[a-zA-Z0-9._-]+\.json$/;

interface PackagedBootSmokeRequest {
  markerPath: string;
  userDataPath: string;
}

interface PackagedBootSmokeMarker {
  schemaVersion: 1;
  productName: "TritonAI Installer";
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  healthyForMs: number;
  readyAt: string;
}

function readPackagedBootSmokeRequest(
  args: string[],
  temporaryDirectory: string,
  environment: NodeJS.ProcessEnv = process.env
): PackagedBootSmokeRequest | null {
  const values = args
    .filter((argument) => argument.startsWith(SMOKE_MARKER_ARGUMENT))
    .map((argument) => argument.slice(SMOKE_MARKER_ARGUMENT.length));
  if (environment[SMOKE_MARKER_ENVIRONMENT]) {
    values.push(environment[SMOKE_MARKER_ENVIRONMENT]);
  }
  if (values.length === 0) return null;
  if (values.length !== 1 || !values[0]) {
    throw new Error("Packaged boot smoke testing requires exactly one marker path.");
  }

  const markerPath = path.resolve(values[0]);
  const expectedParent = path.resolve(temporaryDirectory);
  if (path.dirname(markerPath) !== expectedParent || !SMOKE_MARKER_NAME.test(path.basename(markerPath))) {
    throw new Error(`Packaged boot smoke marker must be a direct child of the system temporary directory: ${markerPath}`);
  }
  if (fs.existsSync(markerPath)) {
    throw new Error(`Packaged boot smoke marker already exists: ${markerPath}`);
  }
  const userDataPath = `${markerPath}.userdata`;
  if (fs.existsSync(userDataPath)) {
    throw new Error(`Packaged boot smoke user-data path already exists: ${userDataPath}`);
  }

  return {
    markerPath,
    userDataPath
  };
}

function writePackagedBootSmokeMarker(
  request: PackagedBootSmokeRequest,
  marker: PackagedBootSmokeMarker
) {
  const descriptor = fs.openSync(request.markerPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertInstallMutationAllowed(request: PackagedBootSmokeRequest | null) {
  if (request) {
    throw new Error("Packaged boot smoke mode cannot start installation or mutate managed state.");
  }
}

export {
  PackagedBootSmokeMarker,
  PackagedBootSmokeRequest,
  assertInstallMutationAllowed,
  readPackagedBootSmokeRequest,
  writePackagedBootSmokeMarker
};

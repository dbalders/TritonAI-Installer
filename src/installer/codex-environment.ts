const { UCSD } = require("./constants");

function getTritonAiEnvironment(paths) {
  return {
    [UCSD.baseUrlEnv]: UCSD.baseUrl,
    [UCSD.tritonAiHomeEnv]: paths.t3Home
  };
}

function getCodexProviderEnvironment(paths) {
  return {
    [UCSD.baseUrlEnv]: UCSD.baseUrl
  };
}

function getCodexProviderEnvironmentVariables(paths) {
  return Object.entries(getCodexProviderEnvironment(paths)).map(([name, value]) => ({
    name,
    value,
    sensitive: false
  }));
}

function removeManagedTritonAiApiKey(environment = []) {
  return (Array.isArray(environment) ? environment : [])
    .filter((variable) => variable?.name?.toUpperCase() !== UCSD.apiKeyEnv);
}

module.exports = {
  getTritonAiEnvironment,
  getCodexProviderEnvironment,
  getCodexProviderEnvironmentVariables,
  removeManagedTritonAiApiKey
};

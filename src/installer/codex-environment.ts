const { UCSD } = require("./constants");

function getTritonAiEnvironment(paths) {
  return {
    [UCSD.baseUrlEnv]: UCSD.baseUrl,
    [UCSD.tritonAiHomeEnv]: paths.t3Home
  };
}

function getCodexProviderEnvironment(paths) {
  return {
    [UCSD.baseUrlEnv]: UCSD.baseUrl,
    ...(paths.tritonAiApiKey ? { [UCSD.apiKeyEnv]: paths.tritonAiApiKey } : {})
  };
}

function getCodexProviderEnvironmentVariables(paths) {
  return Object.entries(getCodexProviderEnvironment(paths)).map(([name, value]) => ({
    name,
    value,
    sensitive: name === UCSD.apiKeyEnv
  }));
}

module.exports = {
  getTritonAiEnvironment,
  getCodexProviderEnvironment,
  getCodexProviderEnvironmentVariables
};

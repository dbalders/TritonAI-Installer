const MANAGED_SKILLS_MANIFEST_VERSION = 1;
const MANAGED_SKILLS_MANIFEST_KIND = "tritonai-secure";

function isValidSkillName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function createManagedSkillsManifest(skills) {
  return {
    version: MANAGED_SKILLS_MANIFEST_VERSION,
    kind: MANAGED_SKILLS_MANIFEST_KIND,
    skills: normalizeSkillNames(skills, "managed skills manifest")
  };
}

function validateManagedSkillsManifest(value, label = "managed skills manifest") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (value.version !== MANAGED_SKILLS_MANIFEST_VERSION) {
    throw new Error(`${label} has unsupported version ${JSON.stringify(value.version)}; expected ${MANAGED_SKILLS_MANIFEST_VERSION}.`);
  }
  if (value.kind !== MANAGED_SKILLS_MANIFEST_KIND) {
    throw new Error(`${label} has unsupported kind ${JSON.stringify(value.kind)}; expected ${JSON.stringify(MANAGED_SKILLS_MANIFEST_KIND)}.`);
  }
  if (!Array.isArray(value.skills)) {
    throw new Error(`${label} must include a skills array.`);
  }

  return {
    version: MANAGED_SKILLS_MANIFEST_VERSION,
    kind: MANAGED_SKILLS_MANIFEST_KIND,
    skills: normalizeSkillNames(value.skills, label)
  };
}

function normalizeSkillNames(skills, label) {
  const unique = new Set();
  for (const name of skills) {
    if (!isValidSkillName(name)) {
      throw new Error(`${label} contains invalid skill name ${JSON.stringify(name)}.`);
    }
    if (unique.has(name)) {
      throw new Error(`${label} contains duplicate skill name ${JSON.stringify(name)}.`);
    }
    unique.add(name);
  }
  return Array.from(unique).sort();
}

module.exports = {
  MANAGED_SKILLS_MANIFEST_VERSION,
  MANAGED_SKILLS_MANIFEST_KIND,
  createManagedSkillsManifest,
  isValidSkillName,
  validateManagedSkillsManifest
};

const INSTALL_PROGRESS_MILESTONES: Record<string, { start: number; details: number[] }> = {
  prepare: { start: 1, details: [2, 3, 4, 5] },
  connect: { start: 6, details: [7, 8, 9] },
  tools: { start: 10, details: [10, 10, 10, 10] },
  verify: { start: 98, details: [99, 99] }
};

const MAC_APP_INSTALL_PROGRESS = { start: 11, details: [12, 15, 22, 67, 75, 78, 82, 97] };
const WINDOWS_APP_INSTALL_PROGRESS = { start: 11, details: [25, 25, 30, 82, 90, 92, 94, 97] };

function getInstallProgress(platform: string, stepId: string, completedDetailIndex: number): number {
  const milestone = stepId === "shortcut"
    ? platform === "win32" ? WINDOWS_APP_INSTALL_PROGRESS : MAC_APP_INSTALL_PROGRESS
    : INSTALL_PROGRESS_MILESTONES[stepId];
  if (!milestone) return 0;
  if (completedDetailIndex < 0 || milestone.details.length === 0) return milestone.start;
  return milestone.details[Math.min(completedDetailIndex, milestone.details.length - 1)];
}

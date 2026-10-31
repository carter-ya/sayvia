export function browserLaunchOptions() {
  const executablePath = process.env.SAYVIA_CHROME_PATH;
  return executablePath ? { executablePath } : {};
}

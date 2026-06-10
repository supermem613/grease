const SECRET_PATTERNS = [
  /\b(ghp|github_pat|glpat|sk|xox[baprs])-[-_A-Za-z0-9]{12,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
];

export function redactText(value, maxLength = 2000) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}...`;
  }
  return text;
}

export function summarizeValue(value, maxLength = 4000) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return redactText(value, maxLength);
  }
  try {
    return redactText(JSON.stringify(value), maxLength);
  } catch (error) {
    return redactText(String(value), maxLength);
  }
}

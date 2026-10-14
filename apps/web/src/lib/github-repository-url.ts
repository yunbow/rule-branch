/** Only owner/repo identifiers are used to construct external repository links. */
export function githubRepositoryUrl(fullName: string): string | null {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return null;
  return "https://github.com/" + parts.map(encodeURIComponent).join("/");
}

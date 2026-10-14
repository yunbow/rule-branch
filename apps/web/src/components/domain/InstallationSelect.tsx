"use client";

import { Select } from "../ui/index.tsx";

export type InstallationOption = {
  id: string;
  githubInstallationId: string;
  accountLogin?: string;
  repositorySelection: string;
};

export function InstallationSelect({
  installations,
  value,
  onChange,
  label = "GitHub App インストール",
}: {
  installations: InstallationOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">GitHubアカウントを選択</option>
    {installations.filter((item) => item.repositorySelection === "selected").map((item) =>
      <option key={item.id} value={item.id}>{item.accountLogin ?? item.githubInstallationId}</option>,
    )}
  </Select>;
}
